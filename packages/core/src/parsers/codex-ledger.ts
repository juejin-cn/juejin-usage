/**
 * Codex thread-ledger fallback — source `codex`, collector `codex-ledger`.
 *
 * Codex keeps a SQLite ledger at `<codex-home>/state_<n>.sqlite`. Its `threads`
 * table stores each thread's `rollout_path` next to the thread's lifetime
 * `tokens_used`, which equals the `total_token_usage.total_tokens` its rollout
 * JSONL ends on.
 *
 * A rollout file can disappear while its thread row survives: Codex's
 * `legacy_to_paginated_v1` migration rewrites a thread into the paginated store
 * and then deletes the legacy `.jsonl`. `parseCodexIncremental` has nothing
 * left to read, so the tokens that thread spent vanish from the dashboard even
 * though the ledger still knows the total. This module reads that total back.
 *
 * The ledger only keeps one lifetime total with no input/output/cache split, so
 * the delta is reported as `input_tokens` — the same convention `warp.ts` uses
 * for its unsplit totals. Everything lands in the half-hour slot holding
 * `recency_at_ms` (the thread's last activity), the finest granularity the
 * ledger preserves, and carries collector `codex-ledger` so it stays
 * distinguishable from rollout-derived rows.
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { TokenTotals } from '../types.js';
import { codexHomeCandidates } from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import { UNKNOWN_MODEL } from '../queue/align-unknown.js';
import { accumulateBucket, computeTotalTokens, type BucketAccumulator } from './shared.js';
import { queryDbJson, readSqliteWithSnapshot, sqliteTableExists } from './sqlite.js';

export const CODEX_LEDGER_COLLECTOR = 'codex-ledger';

/** Codex names its ledger `state_<schema-version>.sqlite`. */
const LEDGER_FILE_NAME = /^state(?:_\d+)?\.sqlite$/;

const THREADS_TABLE = 'threads';

/**
 * Columns the fallback needs, with the literal to project when a Codex version
 * does not have them yet. Keeping the projection explicit avoids `SELECT *`,
 * which would pull the thread preview/summary text columns into memory.
 */
const LEDGER_COLUMNS: ReadonlyArray<readonly [column: string, missing: string]> = [
  ['id', `''`],
  ['rollout_path', `''`],
  ['tokens_used', '0'],
  ['model', `''`],
  ['cwd', `''`],
  ['recency_at_ms', '0'],
  ['created_at_ms', '0'],
];

export interface CodexLedgerThread {
  id: string;
  /** Absolute rollout path when the thread was written; `''` when unknown. */
  rolloutPath: string;
  /** Thread lifetime total, matching the rollout's final `total_token_usage`. */
  tokensUsed: number;
  model: string;
  cwd: string;
  /** Last activity, falling back to creation; `0` when the ledger has neither. */
  timestampMs: number;
}

/** Ledger databases under every Codex home (may not exist). */
export function codexLedgerDbPaths(): string[] {
  const paths: string[] = [];
  for (const home of codexHomeCandidates()) {
    let entries: string[];
    try {
      entries = readdirSync(home);
    } catch {
      // A configured home that was never created is expected.
      continue;
    }
    for (const name of entries.sort()) {
      if (!LEDGER_FILE_NAME.test(name)) continue;
      const dbPath = join(home, name);
      if (!paths.includes(dbPath)) paths.push(dbPath);
    }
  }
  return paths;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Read `threads` from a Codex ledger.
 *
 * Best-effort: a missing table (older ledger) yields no rows, so callers keep
 * working when the fallback cannot apply. Columns are probed first because the
 * table gained `model` / `cwd` / `*_ms` / `history_mode` over time.
 */
export function readCodexLedgerThreads(dbPath: string): CodexLedgerThread[] {
  if (!sqliteTableExists(dbPath, THREADS_TABLE)) return [];

  const present = new Set(
    queryDbJson(dbPath, `SELECT name FROM pragma_table_info('${THREADS_TABLE}')`).map((row) =>
      asText(row.name),
    ),
  );
  const projection = LEDGER_COLUMNS.map(([column, missing]) =>
    present.has(column) ? column : `${missing} AS ${column}`,
  ).join(', ');

  const rows = queryDbJson(dbPath, `SELECT ${projection} FROM ${THREADS_TABLE}`, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });

  const threads: CodexLedgerThread[] = [];
  for (const row of rows) {
    const id = asText(row.id);
    if (!id) continue;
    const recency = asCount(row.recency_at_ms);
    threads.push({
      id,
      rolloutPath: asText(row.rollout_path),
      tokensUsed: asCount(row.tokens_used),
      model: asText(row.model),
      cwd: asText(row.cwd),
      timestampMs: recency > 0 ? recency : asCount(row.created_at_ms),
    });
  }
  return threads;
}

export interface CollectCodexLedgerOptions {
  /**
   * Basenames of every rollout `parseCodexIncremental` has recorded a cursor
   * for. Rollout names embed a UUID, so a basename identifies a thread even if
   * the surrounding directory layout changes.
   */
  countedRolloutNames: ReadonlySet<string>;
  /** Per-thread lifetime total already reported, from either collector. */
  ledgerTotals: Record<string, { tokens: number }>;
  /** Per-ledger mtime, so an unchanged database is not re-read every poll. */
  dbMtimes: Record<string, number>;
  sinceMs: number;
  bucketState: BucketAccumulator;
}

export interface CollectCodexLedgerResult {
  eventsParsed: number;
  filesProcessed: number;
  /** Set when the ledger could not be read; collection continues regardless. */
  error?: string;
}

/**
 * Attribute the ledger total of every thread whose rollout is gone.
 *
 * Emits the *delta* since the last observed total, so a thread that is still
 * growing keeps contributing and one that never changes contributes once.
 */
function emitThread(thread: CodexLedgerThread, opts: CollectCodexLedgerOptions): boolean {
  const previous = opts.ledgerTotals[thread.id]?.tokens ?? 0;

  // A recorded rollout cursor means the JSONL scanner owns this thread: either
  // the file is still on disk, or it was fully counted before it was removed.
  // Seed the watermark and stay silent — emitting here would report tokens the
  // rollout already contributed.
  if (thread.rolloutPath !== '' && opts.countedRolloutNames.has(basename(thread.rolloutPath))) {
    opts.ledgerTotals[thread.id] = { tokens: thread.tokensUsed };
    return false;
  }

  // A total that shrank means Codex restarted the thread's accounting.
  const isReset = thread.tokensUsed > 0 && thread.tokensUsed < previous;
  const delta = isReset ? thread.tokensUsed : Math.max(0, thread.tokensUsed - previous);
  opts.ledgerTotals[thread.id] = { tokens: thread.tokensUsed };
  if (delta === 0) return false;

  if (thread.timestampMs <= 0) return false;
  const hourStart = toUtcHalfHourStart(new Date(thread.timestampMs).toISOString());
  if (!hourStart || new Date(hourStart).getTime() < opts.sinceMs) return false;

  const body = {
    input_tokens: delta,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const totals: TokenTotals = {
    ...body,
    total_tokens: computeTotalTokens(body),
    // The ledger cannot say how many turns ran, only that the thread did.
    conversation_count: previous === 0 || isReset ? 1 : 0,
  };
  accumulateBucket(
    opts.bucketState,
    'codex',
    thread.model || UNKNOWN_MODEL,
    thread.cwd ? resolveProjectName(thread.cwd) : UNKNOWN_MODEL,
    hourStart,
    totals,
    CODEX_LEDGER_COLLECTOR,
  );
  return true;
}

export function collectCodexLedgerBuckets(
  opts: CollectCodexLedgerOptions,
): CollectCodexLedgerResult {
  const dbPaths = codexLedgerDbPaths();
  if (dbPaths.length === 0) return { eventsParsed: 0, filesProcessed: 0 };

  let eventsParsed = 0;
  let filesProcessed = 0;

  try {
    for (const dbPath of dbPaths) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(dbPath).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw err;
      }
      if (mtimeMs > 0 && mtimeMs === opts.dbMtimes[dbPath]) continue;

      const threads = readSqliteWithSnapshot(dbPath, readCodexLedgerThreads);
      filesProcessed += 1;
      for (const thread of threads) {
        if (emitThread(thread, opts)) eventsParsed += 1;
      }
      opts.dbMtimes[dbPath] = mtimeMs;
    }
  } catch (err) {
    // The ledger is a fallback: an unreadable or locked database must not stop
    // rollout collection, which is still the primary source.
    return {
      eventsParsed,
      filesProcessed,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return { eventsParsed, filesProcessed };
}

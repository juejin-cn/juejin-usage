/**
 * PI-Desktop (Electron desktop agent) keeps its own store, separate from the
 * `pi` CLI agent that `parsers/pi.ts` reads out of `~/.pi/agent/sessions`:
 *
 *   ~/.pi-desktop/pi.sqlite
 *     turns(id, session_id, model_id, input_tokens, output_tokens,
 *           usage_json, started_at, ended_at)
 *     sessions(id, project_id, ...) → projects(id, path, name)
 *
 * `turns.usage_json` is the per-turn rollup and carries a complete
 * `operations[]` list (one entry per model call; the rollup total equals the
 * sum of the operations), so per-model attribution comes from there. Both
 * levels are cumulative while a turn is running, so tokens are tracked per
 * `turnId|model` and only the difference is appended.
 *
 * PI-Desktop's own token fields are exclusive of each other:
 *   totalTokens = inputTokens + outputTokens + cacheReadTokens
 * and `reasoningTokens` is reported on the side, outside that total. Every
 * queue bucket follows the five-field-sum convention (the server recomputes
 * `total_tokens`), so the total is rebuilt from the fields instead of copied.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  expandHomePath,
  type BucketAccumulator,
} from './shared.js';
import { queryDbJson, readSqliteWithSnapshot, sqliteTableExists } from './sqlite.js';
import { diffGeminiTotals, sameGeminiTotals } from './gemini.js';

export const PI_DESKTOP_COLLECTOR = 'pi-desktop';

type PiDesktopTotals = Omit<TokenTotals, 'conversation_count'>;
type PiDesktopOperations = NonNullable<CursorsFile['piDesktop']>['operations'] & object;

/** PI-Desktop app data directory ($PI_DESKTOP_HOME or ~/.pi-desktop). */
export function piDesktopHome(): string {
  const env = process.env.PI_DESKTOP_HOME?.trim();
  return env ? expandHomePath(env) : join(homedir(), '.pi-desktop');
}

/** PI-Desktop SQLite store. */
export function piDesktopDbPath(): string {
  return join(piDesktopHome(), 'pi.sqlite');
}

function numField(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function coerceEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** Accepts `camelCase` (PI-Desktop) and `snake_case` (future exports) fields. */
function totalsFromUsage(usage: Record<string, unknown>): PiDesktopTotals | null {
  const delta = {
    input_tokens: numField(usage.inputTokens ?? usage.input_tokens),
    output_tokens: numField(usage.outputTokens ?? usage.output_tokens),
    cached_input_tokens: numField(usage.cacheReadTokens ?? usage.cache_read_tokens),
    cache_creation_input_tokens: numField(usage.cacheWriteTokens ?? usage.cache_write_tokens),
    reasoning_output_tokens: numField(usage.reasoningTokens ?? usage.reasoning_tokens),
  };
  const reportedTotal = numField(usage.totalTokens ?? usage.total_tokens);
  // Keep the app's own total when it is larger than the five-field sum, like
  // the sibling `pi` parser; otherwise the computed sum wins.
  const total = Math.max(computeTotalTokens(delta), reportedTotal);
  if (total <= 0) return null;
  return { ...delta, total_tokens: total };
}

function addTotals(a: PiDesktopTotals, b: PiDesktopTotals): PiDesktopTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface PiDesktopIngestOptions {
  turnId: string;
  model: string;
  totals: PiDesktopTotals;
  project: string;
  timestampMs: number;
  sinceMs: number;
  /** 1 for the first bucket of a turn, 0 for the rest (and for later growth). */
  conversationCount: number;
  operations: PiDesktopOperations;
  bucketState: BucketAccumulator;
}

/**
 * Appends only what grew since the last poll. In every build observed so far a
 * turn's `operations[]` is append-only, so its per-model rollup never shrinks;
 * a rewrite would make `diffGeminiTotals` re-emit the whole snapshot (the same
 * trade-off `zcode` makes for its cumulative usage rows).
 *
 * `timestampMs` is the turn's completion time, or the observation time while
 * it is still running, so a delta lands near the half hour it was spent in.
 */
function ingestUsage(opts: PiDesktopIngestOptions): number {
  const {
    turnId,
    model,
    totals,
    project,
    timestampMs,
    sinceMs,
    conversationCount,
    operations,
    bucketState,
  } = opts;

  const key = `${turnId}|${model}`;
  const prev = operations[key]?.lastTotals;
  const delta = diffGeminiTotals(totals, prev);
  if (!sameGeminiTotals(totals, prev)) {
    operations[key] = { lastTotals: totals, at: timestampMs };
  }
  if (!delta) return 0;

  const hourStart = toUtcHalfHourStart(new Date(timestampMs).toISOString());
  if (!hourStart) return 0;
  if (new Date(hourStart).getTime() < sinceMs) return 0;

  accumulateBucket(
    bucketState,
    'pi-desktop',
    model || 'unknown',
    project,
    hourStart,
    { ...delta, conversation_count: conversationCount },
    PI_DESKTOP_COLLECTOR,
  );
  return 1;
}

interface PiDesktopParseStats {
  eventsParsed: number;
  filesProcessed: number;
}

function parseFromDb(
  dbPath: string,
  sinceMs: number,
  operations: PiDesktopOperations,
  bucketState: BucketAccumulator,
): PiDesktopParseStats {
  // `projects` only exists in builds that track projects; older stores keep
  // turns without a project and must not fail the whole query over it.
  const hasProjectMap =
    sqliteTableExists(dbPath, 'sessions') && sqliteTableExists(dbPath, 'projects');
  const projectColumn = hasProjectMap ? 'p.path AS project_path' : 'NULL AS project_path';
  const projectJoin = hasProjectMap
    ? 'LEFT JOIN sessions s ON s.id = t.session_id LEFT JOIN projects p ON p.id = s.project_id'
    : '';

  const since = Math.max(0, Math.floor(sinceMs));
  const query = `SELECT
    t.id AS turn_id,
    t.model_id AS model_id,
    t.usage_json AS usage_json,
    t.started_at AS started_at,
    t.ended_at AS ended_at,
    ${projectColumn}
    FROM turns t
    ${projectJoin}
    WHERE t.usage_json IS NOT NULL
      AND COALESCE(t.ended_at, t.started_at) >= ${since}
    ORDER BY t.started_at ASC`;

  const rows = readSqliteWithSnapshot(dbPath, (snap) => queryDbJson(snap, query));

  let eventsParsed = 0;
  for (const row of rows) {
    const usage = parseJsonObject(row.usage_json);
    if (!usage) continue;

    const turnId = typeof row.turn_id === 'string' ? row.turn_id.trim() : '';
    if (!turnId) continue;
    const turnModel = typeof row.model_id === 'string' ? row.model_id.trim() : '';
    const projectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    const project = projectPath ? resolveProjectName(projectPath) : 'unknown';
    const timestampMs = coerceEpochMs(row.ended_at) ?? coerceEpochMs(row.started_at);
    if (!timestampMs) continue;

    // One bucket dimension per model: agent turns fan out into many model
    // calls, so operations are folded per model instead of tracked one by one.
    const perModel = new Map<string, PiDesktopTotals>();
    const operationsList = Array.isArray(usage.operations)
      ? (usage.operations as unknown[])
      : [];
    for (const raw of operationsList) {
      const operation = parseJsonObject(raw);
      if (!operation) continue;
      const totals = totalsFromUsage(operation);
      if (!totals) continue;
      const model =
        (typeof operation.modelId === 'string' && operation.modelId.trim()) || turnModel;
      const modelKey = model || 'unknown';
      const previous = perModel.get(modelKey);
      perModel.set(modelKey, previous ? addTotals(previous, totals) : totals);
    }
    if (perModel.size === 0) {
      // Older stores keep only the turn rollup.
      const totals = totalsFromUsage(usage);
      if (totals) perModel.set(turnModel || 'unknown', totals);
    }
    if (perModel.size === 0) continue;

    // Count the turn once, on the first sighting of any of its models.
    let conversationCount = Array.from(perModel.keys()).some(
      (model) => operations[`${turnId}|${model}`],
    )
      ? 0
      : 1;

    for (const [model, totals] of perModel) {
      const booked = ingestUsage({
        turnId,
        model,
        totals,
        project,
        timestampMs,
        sinceMs,
        conversationCount,
        operations,
        bucketState,
      });
      eventsParsed += booked;
      // Only hand the conversation over once it is actually booked.
      if (booked > 0) conversationCount = 0;
    }
  }

  return { eventsParsed, filesProcessed: rows.length > 0 ? 1 : 0 };
}

/**
 * Drop dedup entries for turns that fell out of the collect window, so
 * `cursors.json` stays bounded instead of growing with every model call.
 * Entries are only pruned once their turn is excluded by the query above,
 * which is what keeps a re-read from double counting.
 */
function pruneOperations(operations: PiDesktopOperations, sinceMs: number): void {
  for (const [key, entry] of Object.entries(operations)) {
    if (!entry || entry.at < sinceMs) delete operations[key];
  }
}

/** A missing table is normal (nothing to collect); a lock/corrupt DB throws. */
function hasTurnsTable(dbPath: string): boolean {
  const rows = readSqliteWithSnapshot(dbPath, (snap) =>
    queryDbJson(snap, "SELECT name FROM sqlite_master WHERE type='table' AND name='turns' LIMIT 1"),
  );
  return rows.length > 0;
}

export interface ParsePiDesktopResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parsePiDesktopIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParsePiDesktopResult; cursors: CursorsFile }> {
  // An empty `statsSince` must not turn into a NaN timestamp: `${NaN}` in the
  // SQL below is a syntax error, while 0 means "no window" like other parsers.
  const parsedSince = new Date(statsSince).getTime();
  const sinceMs = Number.isFinite(parsedSince) ? parsedSince : 0;
  if (!cursors.piDesktop) cursors.piDesktop = {};
  const root = cursors.piDesktop;
  if (!root.operations) root.operations = {};
  const operations = root.operations;
  const bucketState: BucketAccumulator = new Map();

  const dbPath = piDesktopDbPath();
  if (!existsSync(dbPath)) {
    return { result: { buckets: [], eventsParsed: 0, filesProcessed: 0 }, cursors };
  }

  try {
    // A lock or a schema change must not take the other channels down with it:
    // `syncAll` runs sources back-to-back without a per-source try/catch.
    if (!hasTurnsTable(dbPath)) {
      return { result: { buckets: [], eventsParsed: 0, filesProcessed: 0 }, cursors };
    }
    const parsed = parseFromDb(dbPath, sinceMs, operations, bucketState);
    pruneOperations(operations, sinceMs);
    return {
      result: {
        buckets: bucketsFromState(bucketState, 'pi-desktop'),
        eventsParsed: parsed.eventsParsed,
        filesProcessed: parsed.filesProcessed,
      },
      cursors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const error = /sqlite3 CLI not found/i.test(msg)
      ? `PI-Desktop 需要 Node >= 22.5 或 sqlite3 CLI 才能读取 ${dbPath}`
      : `PI-Desktop 读取 ${dbPath} 失败：${msg}`;
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error },
      cursors,
    };
  }
}

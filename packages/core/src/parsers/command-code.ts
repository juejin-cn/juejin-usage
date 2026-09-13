import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { commandCodeProjectsDirs } from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  findJsonlFiles,
  type BucketAccumulator,
} from './shared.js';

export const COMMAND_CODE_COLLECTOR = 'command-code';

/** Max lines to scan from file start for header/cwd (incremental sync may start mid-file). */
const HEADER_PEEK_MAX_LINES = 20;

/** Command Code JSONL uses camelCase usage fields. */
interface CommandCodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

interface CommandCodeMessage {
  type?: string;
  timestamp?: string;
  cwd?: string;
  id?: string;
  parentId?: string;
  model?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
  };
  /** Usage is at the top level in Command Code JSONL, not inside message. */
  usage?: CommandCodeUsage;
}

const MAX_SEEN_USAGE = 50_000;

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeCommandCodeUsage(u: CommandCodeUsage): TokenTotals {
  const cacheRead = toCount(u.cacheReadTokens);
  const cacheCreation = toCount(u.cacheWriteTokens);
  // Command Code's inputTokens includes cache-read tokens (same as Claude API).
  // Subtract to avoid double-counting.
  const input = Math.max(0, toCount(u.inputTokens) - cacheRead);
  const output = toCount(u.outputTokens);
  const body = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    reasoning_output_tokens: 0,
  };
  return {
    ...body,
    total_tokens: computeTotalTokens(body),
    conversation_count: 1,
  };
}

function capSeenUsage(seenUsage: Record<string, TokenTotals>): Record<string, TokenTotals> {
  const keys = Object.keys(seenUsage);
  if (keys.length <= MAX_SEEN_USAGE) return seenUsage;
  const drop = keys.length - MAX_SEEN_USAGE;
  const next: Record<string, TokenTotals> = {};
  for (const key of keys.slice(drop)) {
    next[key] = seenUsage[key]!;
  }
  return next;
}

function diffCommandCodeUsage(next: TokenTotals, prev: TokenTotals | undefined): TokenTotals | null {
  if (!prev) {
    return next.total_tokens > 0 ? { ...next, conversation_count: 1 } : null;
  }
  const body = {
    input_tokens: Math.max(0, next.input_tokens - prev.input_tokens),
    output_tokens: Math.max(0, next.output_tokens - prev.output_tokens),
    cached_input_tokens: Math.max(0, next.cached_input_tokens - prev.cached_input_tokens),
    cache_creation_input_tokens: Math.max(
      0,
      next.cache_creation_input_tokens - prev.cache_creation_input_tokens,
    ),
    reasoning_output_tokens: Math.max(
      0,
      next.reasoning_output_tokens - prev.reasoning_output_tokens,
    ),
  };
  const total = computeTotalTokens(body);
  if (total === 0) return null;
  return { ...body, total_tokens: total, conversation_count: 0 };
}

/**
 * Read cwd from the start of a Command Code session JSONL header.
 * Used even when incremental usage parse starts at a non-zero offset.
 */
export async function peekCommandCodeCwd(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  try {
    for await (const line of rl) {
      lines += 1;
      if (lines > HEADER_PEEK_MAX_LINES) break;
      if (!line.includes('"cwd"')) continue;
      let obj: CommandCodeMessage;
      try {
        obj = JSON.parse(line) as CommandCodeMessage;
      } catch {
        continue;
      }
      const cwd = typeof obj.cwd === 'string' ? obj.cwd.trim() : '';
      if (cwd) return cwd;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

export async function resolveCommandCodeProject(filePath: string): Promise<string> {
  const cwd = await peekCommandCodeCwd(filePath);
  if (cwd) return resolveProjectName(cwd);
  return 'unknown';
}

interface PendingCommandCodeRow {
  model: string;
  project: string;
  hourStart: string;
  totals: TokenTotals;
}

export async function listCommandCodeProjectFiles(): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const projectsDir of commandCodeProjectsDirs()) {
    for (const f of await findJsonlFiles(projectsDir)) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }
  return files.sort();
}

export interface ParseCommandCodeResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
}

export async function parseCommandCodeIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseCommandCodeResult; cursors: CursorsFile }> {
  const files = await listCommandCodeProjectFiles();
  const sinceMs = new Date(statsSince).getTime();

  if (!cursors.commandCode) {
    cursors.commandCode = { files: {}, seenHashes: [], seenUsage: {} };
  }
  const ccCursor = cursors.commandCode;
  if (!ccCursor.seenUsage) ccCursor.seenUsage = {};
  const seenUsage = ccCursor.seenUsage;
  const legacyHashes = new Set(ccCursor.seenHashes ?? []);
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  const commitRow = (row: PendingCommandCodeRow, dedup: string | null): void => {
    if (dedup) {
      const prev = seenUsage[dedup];
      if (!prev && legacyHashes.has(dedup)) {
        seenUsage[dedup] = row.totals;
        return;
      }
      const delta = diffCommandCodeUsage(row.totals, prev);
      seenUsage[dedup] = row.totals;
      if (!delta) return;
      accumulateBucket(
        bucketState,
        'command-code',
        row.model,
        row.project,
        row.hourStart,
        delta,
        COMMAND_CODE_COLLECTOR,
      );
      eventsParsed += 1;
      return;
    }
    accumulateBucket(
      bucketState,
      'command-code',
      row.model,
      row.project,
      row.hourStart,
      row.totals,
      COMMAND_CODE_COLLECTOR,
    );
    eventsParsed += 1;
  };

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = ccCursor.files[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;

    if (sameInode && !truncated && startOffset >= st.size) {
      continue;
    }

    const project =
      sameInode && prev.project
        ? prev.project
        : await resolveCommandCodeProject(filePath);

    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const keyedRows = new Map<string, PendingCommandCodeRow>();
    const unkeyedRows: PendingCommandCodeRow[] = [];

    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let obj: CommandCodeMessage;
      try {
        obj = JSON.parse(line) as CommandCodeMessage;
      } catch {
        continue;
      }
      if (obj.type !== 'message') continue;
      if (obj.message?.role !== 'assistant') continue;
      const usage = obj.usage;
      if (!usage) continue;

      const ts = obj.timestamp;
      if (!ts) continue;
      const hourStart = toUtcHalfHourStart(ts);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const totals = normalizeCommandCodeUsage(usage);
      if (totals.total_tokens === 0) continue;

      const pending: PendingCommandCodeRow = {
        model: obj.message?.model ?? obj.model ?? 'unknown',
        hourStart,
        totals,
        project,
      };
      const msgId = obj.message?.id;
      if (msgId) {
        keyedRows.set(msgId, pending);
      } else {
        unkeyedRows.push(pending);
      }
    }

    for (const [dedup, row] of keyedRows) {
      commitRow(row, dedup);
    }
    for (const row of unkeyedRows) {
      commitRow(row, null);
    }

    ccCursor.files[filePath] = {
      inode,
      offset: st.size,
      project,
    };
    filesProcessed += 1;
  }

  capSeenUsage(seenUsage);

  return {
    result: {
      buckets: bucketsFromState(bucketState, COMMAND_CODE_COLLECTOR),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

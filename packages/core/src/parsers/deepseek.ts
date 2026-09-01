import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import { resolveProjectName } from '../project-name.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  findJsonlFiles,
  type BucketAccumulator,
} from './shared.js';

export const DEEPSEEK_COLLECTOR = 'deepseek-harness';

// DeepSeek Harness session paths
export function deepseekHome(): string {
  const env = process.env.DSH_HOME?.trim();
  if (env) {
    return env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
  }
  return join(homedir(), '.dsh');
}

export function deepseekSessionsDir(): string {
  return join(deepseekHome(), 'sessions');
}

interface DeepseekUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens?: number;
}

/** DSH stream usage records use camelCase fields (`inputTokens`, …). */
interface DshStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeDeepseekUsage(u: DeepseekUsage): TokenTotals {
  const input = toCount(u.input_tokens);
  const output = toCount(u.output_tokens);
  const cacheRead = toCount(u.cache_read_input_tokens);
  const cacheCreation = toCount(u.cache_creation_input_tokens);
  const reasoning = toCount(u.reasoning_output_tokens);

  const body = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    reasoning_output_tokens: reasoning,
  };

  return {
    ...body,
    total_tokens: computeTotalTokens(body),
    conversation_count: 1,
  };
}

function normalizeDshStreamUsage(u: DshStreamUsage): TokenTotals {
  return normalizeDeepseekUsage({
    input_tokens: toCount(u.inputTokens),
    output_tokens: toCount(u.outputTokens),
    cache_read_input_tokens: toCount(u.cacheReadTokens),
    cache_creation_input_tokens: toCount(u.cacheWriteTokens),
    reasoning_output_tokens: toCount(u.reasoningTokens),
  });
}

interface PendingDeepseekRow {
  model: string;
  project: string;
  collector: string;
  hourStart: string;
  totals: TokenTotals;
  /** Stable per-file dedup key (filePath + event identity). */
  dedupKey: string;
}

/** DSH event time may be epoch milliseconds (current) or an ISO string (legacy). */
function eventHourStart(rawTime: unknown): string | null {
  if (typeof rawTime === 'number' && Number.isFinite(rawTime) && rawTime > 0) {
    return toUtcHalfHourStart(new Date(rawTime).toISOString());
  }
  if (typeof rawTime === 'string') {
    const t = rawTime.trim();
    if (/^\d{10,13}$/.test(t)) {
      return toUtcHalfHourStart(new Date(Number(t)).toISOString());
    }
    return toUtcHalfHourStart(t);
  }
  return null;
}

/** Stable dedup identity: `seq` is unique per session; fall back to time+type. */
function eventDedupKey(obj: Record<string, unknown>): string | null {
  const seq = obj.seq;
  if (typeof seq === 'number' || (typeof seq === 'string' && seq.length > 0)) {
    return `s:${seq}`;
  }
  const time = obj.time;
  if (time != null) {
    return `t:${String(time)}:${String(obj.type ?? '')}`;
  }
  return null;
}

/** Track the model in effect for the current session from routing / message events. */
function modelFromSessionEvent(obj: Record<string, any>): string | null {
  if (obj.type === 'request/context') {
    const m = obj.data?.model;
    if (typeof m === 'string' && m) return m;
  }
  if (obj.type === 'request/header') {
    const m = obj.data?.header?.config?.model;
    if (typeof m === 'string' && m) return m;
  }
  if (obj.type === 'assistant/message') {
    const m = obj.data?.message?.source?.model;
    if (typeof m === 'string' && m) return m;
    const p = obj.data?.message?.source?.provider;
    if (typeof p === 'string' && p) return p;
  }
  // Legacy events carry the model at the top level ({"type":"assistant","model":…}).
  const topLevelModel = obj.model;
  if (typeof topLevelModel === 'string' && topLevelModel) return topLevelModel;
  return null;
}

/** Resolve the display project from the session header event (carries `cwd`). */
function projectFromSessionEvent(obj: Record<string, any>): string | null {
  if (obj.type === 'session' && typeof obj.cwd === 'string' && obj.cwd.trim()) {
    return resolveProjectName(obj.cwd);
  }
  return null;
}

/** Fallback: `sessions/<project-slug>/session-…/session.jsonl(.zstd)`. */
function projectFromSessionPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/sessions\/([^/]+)\//);
  if (!match?.[1]) return 'unknown';
  return match[1].replace(/^-+|-+$/g, '') || 'unknown';
}

/** Decompress a possibly multi-frame zstd file into lines. */
function readZstdLines(buf: Buffer): string[] {
  const lines: string[] = [];
  const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let offset = 0;
  while (offset < buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, offset);
    if (idx < 0) break;
    const next = buf.indexOf(ZSTD_MAGIC, idx + 4);
    const end = next < 0 ? buf.length : next;
    try {
      const text = zstdDecompressSync(buf.subarray(idx, end)).toString('utf8');
      lines.push(...text.split('\n'));
    } catch {
      // Skip frames that fail to decompress (e.g. still being written).
    }
    offset = end;
  }
  return lines;
}

/**
 * Extract one countable usage row from a session event.
 *
 * DSH records each step's token accounting both as an `assistant/chunk`
 * `{type:'usage'}` event and (paired, same numbers) on the following
 * `assistant/message` event. We count the chunk usage only so the pair is not
 * double-counted. Legacy `assistant` / `tool/result` events carrying a `tokens`
 * map are kept as a fallback for older session files.
 */
function extractUsage(
  obj: Record<string, any>,
  filePath: string,
): Pick<PendingDeepseekRow, 'hourStart' | 'totals' | 'collector' | 'dedupKey'> | null {
  if (obj.type === 'assistant/chunk' && obj.data?.chunk?.type === 'usage' && obj.data.chunk.usage) {
    const hourStart = eventHourStart(obj.time);
    if (!hourStart) return null;
    const totals = normalizeDshStreamUsage(obj.data.chunk.usage);
    if (totals.total_tokens === 0) return null;
    const key = eventDedupKey(obj);
    if (!key) return null;
    return { hourStart, totals, collector: DEEPSEEK_COLLECTOR, dedupKey: `${filePath}#${key}` };
  }

  // Legacy format: {"type":"assistant","seq":…,"ts":"…","tokens":{…}}
  if (
    (obj.type === 'assistant' || obj.type === 'tool/result') &&
    obj.tokens &&
    typeof obj.tokens === 'object'
  ) {
    const hourStart = eventHourStart(obj.ts ?? obj.time);
    if (!hourStart) return null;
    const totals = normalizeDeepseekUsage({
      input_tokens: toCount(obj.tokens.input),
      output_tokens: toCount(obj.tokens.output),
      cache_read_input_tokens: toCount(obj.tokens.cache_read),
      cache_creation_input_tokens: toCount(obj.tokens.cache_creation),
      reasoning_output_tokens: toCount(obj.tokens.reasoning),
    });
    if (totals.total_tokens === 0) return null;
    const key = eventDedupKey(obj);
    if (!key) return null;
    return { hourStart, totals, collector: DEEPSEEK_COLLECTOR, dedupKey: `${filePath}#${key}` };
  }

  return null;
}

export async function parseDeepseekIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseDeepseekResult; cursors: CursorsFile }> {
  const sessionsDir = deepseekSessionsDir();
  if (!existsSync(sessionsDir)) {
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: 'DeepSeek Harness not installed' },
      cursors,
    };
  }

  const files = await findJsonlFiles(sessionsDir);
  const sinceMs = new Date(statsSince).getTime();

  if (!cursors.deepseek) {
    cursors.deepseek = { files: {}, seenHashes: [] };
  }
  const deepseekCursor = cursors.deepseek;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = deepseekCursor.files[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;

    // Fast path: unchanged file → no new bytes.
    if (sameInode && !truncated && startOffset >= st.size) {
      continue;
    }

    // Session logs are multi-frame zstd; plain `.jsonl` also works.
    const lines = filePath.endsWith('.zstd')
      ? readZstdLines(readFileSync(filePath))
      : readFileSync(filePath, 'utf8').split('\n');

    const seen = new Set(deepseekCursor.seenHashes ?? []);
    const rows: PendingDeepseekRow[] = [];
    let project: string | null = null;
    let currentModel: string | null = null;

    for (const line of lines) {
      if (
        !line.includes('"usage"') &&
        !line.includes('"tokens"') &&
        !line.includes('"model"') &&
        !line.includes('"cwd"')
      ) {
        continue;
      }
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;

      if (!project) project = projectFromSessionEvent(obj);
      const m = modelFromSessionEvent(obj);
      if (m) currentModel = m;

      const usage = extractUsage(obj, filePath);
      if (!usage) continue;
      if (new Date(usage.hourStart).getTime() < sinceMs) continue;

      rows.push({
        ...usage,
        model: currentModel ?? 'unknown',
        project: project ?? projectFromSessionPath(filePath),
      });
    }

    for (const row of rows) {
      if (seen.has(row.dedupKey)) continue;
      accumulateBucket(
        bucketState,
        'deepseek',
        row.model,
        row.project,
        row.hourStart,
        row.totals,
        row.collector,
      );
      seen.add(row.dedupKey);
      eventsParsed += 1;
    }

    deepseekCursor.seenHashes = Array.from(seen).slice(-50_000);
    deepseekCursor.files[filePath] = { inode, size: st.size, mtimeMs: st.mtimeMs, offset: st.size };
    filesProcessed += 1;
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'deepseek'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

export interface ParseDeepseekResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function listDeepseekSessionFiles(): Promise<string[]> {
  const sessionsDir = deepseekSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  return findJsonlFiles(sessionsDir);
}

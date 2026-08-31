import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { sep, join } from 'node:path';
import { homedir } from 'node:os';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
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

interface DeepseekEvent {
  type?: string;
  seq?: number;
  ts?: string;
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_creation?: number;
    reasoning?: number;
  };
  project?: string;
  cwd?: string;
}

interface DeepseekCacheCreation {
  cache_creation_input_tokens?: number;
}

interface DeepseekUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens?: number;
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

export function deepseekMessageDedupKey(obj: DeepseekEvent): string | null {
  const seq = obj?.seq;
  const ts = obj?.ts;
  if (!seq || !ts) return null;
  return `${seq}:${ts}`;
}

interface PendingDeepseekRow {
  model: string;
  project: string;
  collector: string;
  hourStart: string;
  totals: TokenTotals;
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

    // Skip if no new data
    if (sameInode && !truncated && startOffset >= st.size) {
      continue;
    }

    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const pendingRows: PendingDeepseekRow[] = [];

    for await (const line of rl) {
      if (!line.includes('"type"') || !line.includes('"tokens"')) continue;
      
      let obj: DeepseekEvent;
      try {
        obj = JSON.parse(line) as DeepseekEvent;
      } catch {
        continue;
      }

      // Look for assistant responses with token usage
      if (obj.type !== 'assistant' && obj.type !== 'tool/result') continue;
      if (!obj.tokens) continue;

      const ts = obj.ts;
      if (!ts) continue;
      const hourStart = toUtcHalfHourStart(ts);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const usage: DeepseekUsage = {
        input_tokens: obj.tokens.input,
        output_tokens: obj.tokens.output,
        cache_read_input_tokens: obj.tokens.cache_read,
        cache_creation_input_tokens: obj.tokens.cache_creation,
        reasoning_output_tokens: obj.tokens.reasoning,
      };

      const totals = normalizeDeepseekUsage(usage);
      if (totals.total_tokens === 0) continue;

      pendingRows.push({
        model: obj.model || 'unknown',
        project: obj.project || 'unknown',
        collector: DEEPSEEK_COLLECTOR,
        hourStart,
        totals,
      });
    }

    // Process pending rows with deduplication
    const dedup = deepseekMessageDedupKey({ seq: startOffset, ts: new Date().toISOString() });
    if (dedup) {
      const seen = new Set(deepseekCursor.seenHashes || []);
      for (const row of pendingRows) {
        const rowDedup = deepseekMessageDedupKey({ seq: eventsParsed, ts: row.hourStart });
        if (rowDedup && !seen.has(rowDedup)) {
          accumulateBucket(
            bucketState,
            'deepseek',
            row.model,
            row.project,
            row.hourStart,
            row.totals,
            row.collector,
          );
          eventsParsed += 1;
          seen.add(rowDedup);
        }
      }
      deepseekCursor.seenHashes = Array.from(seen).slice(-10000);
    } else {
      for (const row of pendingRows) {
        accumulateBucket(
          bucketState,
          'deepseek',
          row.model,
          row.project,
          row.hourStart,
          row.totals,
          row.collector,
        );
        eventsParsed += 1;
      }
    }

    deepseekCursor.files[filePath] = { inode, offset: st.size };
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

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { QueueBucket, TokenTotals } from '../types.js';
import { alignUnknownIntoDominant } from '../queue/align-unknown.js';

export type BucketAccumulator = Map<
  string,
  TokenTotals & {
    model: string;
    project: string;
    hour_start: string;
    collector?: string;
  }
>;

export function bucketStateKey(
  source: string,
  model: string,
  project: string,
  hourStart: string,
  collector = '',
): string {
  return `${source}|${collector}|${model}|${project}|${hourStart}`;
}

interface JsonlWalkEntry {
  mtimeMs: number;
  jsonl: string[];
  subdirs: string[];
}

const jsonlWalkCache = new Map<string, JsonlWalkEntry>();

/** Test seam. */
export function resetJsonlWalkCache(): void {
  jsonlWalkCache.clear();
}

/**
 * Recursively list `*.jsonl` under `dir`.
 *
 * Directories whose mtime has not changed skip `readdir` and reuse the
 * cached child list; nested dirs are still visited so a new file in a
 * subdirectory is picked up when that subdirectory's mtime changes.
 */
export async function findJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  if (!existsSync(dir)) {
    jsonlWalkCache.delete(dir);
    return results;
  }
  let stMtime = 0;
  try {
    stMtime = (await stat(dir)).mtimeMs;
  } catch {
    jsonlWalkCache.delete(dir);
    return results;
  }

  const prev = jsonlWalkCache.get(dir);
  if (prev && prev.mtimeMs === stMtime) {
    results.push(...prev.jsonl);
    for (const sub of prev.subdirs) {
      results.push(...(await findJsonlFiles(sub)));
    }
    return results;
  }

  const jsonl: string[] = [];
  const subdirs: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(full);
        results.push(...(await findJsonlFiles(full)));
      } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) {
        jsonl.push(full);
        results.push(full);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  jsonlWalkCache.set(dir, { mtimeMs: stMtime, jsonl, subdirs });
  return results;
}

export function sumTokenTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    conversation_count: a.conversation_count + b.conversation_count,
  };
}

export function computeTotalTokens(t: Omit<TokenTotals, 'total_tokens' | 'conversation_count'>): number {
  return (
    t.input_tokens +
    t.output_tokens +
    t.cached_input_tokens +
    t.cache_creation_input_tokens +
    t.reasoning_output_tokens
  );
}

export function accumulateBucket(
  state: BucketAccumulator,
  source: string,
  model: string,
  project: string,
  hourStart: string,
  delta: TokenTotals,
  collector?: string,
): void {
  const coll = collector?.trim() || '';
  const key = bucketStateKey(source, model, project, hourStart, coll);
  const existing = state.get(key);
  if (existing) {
    const merged = sumTokenTotals(existing, delta);
    state.set(key, {
      ...merged,
      model,
      project,
      hour_start: hourStart,
      ...(coll ? { collector: coll } : {}),
    });
  } else {
    state.set(key, {
      ...delta,
      model,
      project,
      hour_start: hourStart,
      ...(coll ? { collector: coll } : {}),
    });
  }
}

export function bucketsFromState(
  state: BucketAccumulator,
  source: string,
): QueueBucket[] {
  const buckets = Array.from(state.values()).map((b) => ({
    hour_start: b.hour_start,
    source,
    model: b.model,
    project: b.project,
    ...(b.collector ? { collector: b.collector } : {}),
    input_tokens: b.input_tokens,
    output_tokens: b.output_tokens,
    cached_input_tokens: b.cached_input_tokens,
    cache_creation_input_tokens: b.cache_creation_input_tokens,
    reasoning_output_tokens: b.reasoning_output_tokens,
    total_tokens: b.total_tokens,
    conversation_count: b.conversation_count,
  }));
  return alignUnknownIntoDominant(buckets);
}

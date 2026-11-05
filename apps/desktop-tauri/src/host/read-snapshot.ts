import {
  computeRowCost, computeTokens, localDateAndHour, localDateNow,
  metricsFromBucket, resolveLocalCollectSince,
  type AggregateCache, type BucketStore, type TudConfig,
} from '@juejin-opensource/jusage-core';
import { normalizeProjectName } from '@juejin-opensource/jusage-core/project-label';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type ReadState = {config:TudConfig; bucketStore:BucketStore; aggregateCache:AggregateCache};

/** Core remains authoritative for pricing, timezone and legacy metric evidence.
 * Rust filters sealed history and aggregates live rows; no queue/cache file is
 * read while Node may be appending or rewriting it. This is a daily-only pilot.
 */
export function buildReadSnapshot(state: ReadState, session: string) {
  const today = localDateNow();
  const since = resolveLocalCollectSince(state.config);
  const statsSinceDate = /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : localDateAndHour(since).date;
  const rows = state.bucketStore.getRows();
  return {
    schemaVersion:1, session, createdAt:Date.now(), today, statsSinceDate,
    closedDays:state.aggregateCache.getDaily(rows, 365, since).days.filter(day => day.date < today),
    rows:rows.filter(row => localDateAndHour(row.hour_start).date === today).map(row => ({
      source:row.source, model:row.model, project:normalizeProjectName(row.project || 'unknown'),
      tokens:computeTokens(row), costUsd:computeRowCost(row),
      inputTokens:row.input_tokens || 0, outputTokens:row.output_tokens || 0,
      cachedInputTokens:row.cached_input_tokens || 0,
      cacheCreationInputTokens:row.cache_creation_input_tokens || 0,
      localMetrics:metricsFromBucket(row),
    })),
  };
}

export class ReadSnapshotPublisher {
  private busy = 0;
  private failed = false;
  private closed = false;
  constructor(readonly path:string, private snapshot:() => ReturnType<typeof buildReadSnapshot>) {}
  invalidate() { rmSync(this.path, {force:true}); }
  publish() {
    if (this.busy || this.failed || this.closed) return;
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), {recursive:true});
      writeFileSync(temporary, JSON.stringify(this.snapshot()), {mode:0o600});
      renameSync(temporary, this.path);
    } catch (error) {
      this.invalidate();
      throw error;
    } finally { rmSync(temporary, {force:true}); }
  }
  async update<T>(mutate:() => Promise<T>):Promise<T> {
    if (!this.busy) this.failed = false;
    this.busy++;
    this.invalidate();
    try { return await mutate(); }
    catch (error) { this.failed = true; throw error; }
    finally { this.busy--; this.publish(); }
  }
  close() { this.closed = true; this.invalidate(); }
}

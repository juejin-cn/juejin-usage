import { setTimeout as delay } from 'node:timers/promises';
import { localEvidence } from '../local-metrics.js';
import type { QueueBucket } from '../types.js';
import { bucketKey, toUtcHalfHourStart } from '../queue/keys.js';
import { record, traeAccountRequest, TRAE_USAGE_COLLECTOR, type TraeAccount } from './trae-account.js';

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('TRAE_USAGE_FORMAT_CHANGED');
  return value;
}

/** A session row is a mutable account snapshot, never an incremental event. */
export function traeUsageBuckets(rows: unknown[], since: number, until: number): QueueBucket[] {
  const sessions = new Map<string, Record<string, unknown>>();
  for (const value of rows) {
    const row = record(value);
    const time = integer(row.usage_time);
    if (typeof row.session_id !== 'string' || !row.session_id || row.session_id.length > 512) throw new Error('TRAE_USAGE_FORMAT_CHANGED');
    // A session can have separate model/type rows. Drop only exact duplicates.
    const key = JSON.stringify([row.session_id, time, row.model_name, row.usage_source, row.product_type_list, row.mode]);
    const previous = sessions.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('TRAE_USAGE_CHANGED_DURING_PAGINATION');
    sessions.set(key, row);
  }
  const buckets = new Map<string, QueueBucket>();
  for (const row of sessions.values()) {
    const time = row.usage_time as number;
    if (time < since || time > until) continue;
    const extra = record(row.extra_info);
    const prompt = integer(extra.input_token), output = integer(extra.output_token);
    const read = integer(extra.cache_read_token ?? 0), write = integer(extra.cache_write_token ?? 0);
    // Match the existing Trae prompt convention: cache reads are part of input.
    // Non-zero writes need vendor validation; do not silently inflate totals.
    if (read > prompt || write > 0) throw new Error('TRAE_CACHE_WRITE_UNVERIFIED');
    const hour = toUtcHalfHourStart(new Date(time * 1000).toISOString());
    if (!hour) throw new Error('TRAE_USAGE_FORMAT_CHANGED');
    const model = typeof row.model_name === 'string' && row.model_name.trim() ? row.model_name.trim() : 'trae-auto';
    if (model.length > 200 || /[\x00-\x1f]/.test(model)) throw new Error('TRAE_USAGE_FORMAT_CHANGED');
    if (typeof row.dollar_float !== 'number' || !Number.isFinite(row.dollar_float) || row.dollar_float < 0) throw new Error('TRAE_USAGE_FORMAT_CHANGED');
    const candidate: QueueBucket = {
      source: 'trae', collector: TRAE_USAGE_COLLECTOR, model, project: 'unknown', hour_start: hour,
      input_tokens: prompt - read, output_tokens: output, cached_input_tokens: read,
      cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
      total_tokens: prompt + output, conversation_count: 0,
      // Session aggregation cannot establish request counts.
      local_metrics: localEvidence(0, false, true, true), reported_cost_usd: row.dollar_float,
    };
    const key = bucketKey(candidate), previous = buckets.get(key);
    if (previous) {
      previous.input_tokens += candidate.input_tokens;
      previous.output_tokens += candidate.output_tokens;
      previous.cached_input_tokens += candidate.cached_input_tokens;
      previous.total_tokens += candidate.total_tokens;
      previous.reported_cost_usd! += candidate.reported_cost_usd!;
    } else buckets.set(key, candidate);
  }
  return [...buckets.values()];
}

export async function fetchTraeUsage(account: TraeAccount, statsSince: string, options: { fetcher?: typeof fetch; now?: number; pageDelayMs?: number } = {}): Promise<QueueBucket[]> {
  const since = Math.floor(Date.parse(statsSince) / 1000), until = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isFinite(since) || since > until) throw new Error('TRAE_USAGE_RANGE_INVALID');
  const rows: unknown[] = [], pages = new Set<string>();
  for (let page = 1; page <= 500; page++) {
    const data = await traeAccountRequest(account, 'query_user_usage_group_by_session', {
      start_time: since, end_time: until, page_size: 100, page_num: page, usage_type: [5, 6],
    }, options.fetcher);
    const batch = data.user_usage_group_by_sessions;
    if (!Array.isArray(batch)) throw new Error('TRAE_USAGE_FORMAT_CHANGED');
    const signature = JSON.stringify(batch);
    if (batch.length && pages.has(signature)) throw new Error('TRAE_USAGE_PAGINATION_STALLED');
    pages.add(signature);
    rows.push(...batch);
    const total = data.total === undefined ? undefined : integer(data.total);
    if (!batch.length) {
      if (total !== undefined && rows.length < total) throw new Error('TRAE_USAGE_INCOMPLETE');
      return traeUsageBuckets(rows, since, until);
    }
    if (total !== undefined && rows.length >= total) return traeUsageBuckets(rows, since, until);
    await delay(options.pageDelayMs ?? 300);
  }
  throw new Error('TRAE_USAGE_TOO_MANY_PAGES');
}

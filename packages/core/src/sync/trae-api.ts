import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localEvidence } from '../local-metrics.js';
import { readTraeAccount, hasTraeGlobalStorage, TRAE_USAGE_COLLECTOR } from '../parsers/trae-account.js';
import { fetchTraeUsage } from '../parsers/trae-usage.js';
import { appendBuckets, loadBucketsForRange } from '../queue/index.js';
import { bucketKey } from '../queue/keys.js';
import type { QueueBucket } from '../types.js';
import type { SyncResult } from './index.js';

/** Absolute replacement (including retractions); queue append wins on replay. */
export function replaceTraeSnapshot(existing: QueueBucket[], fresh: QueueBucket[], since: string): QueueBucket[] {
  const replacement = new Map(fresh.map(row => [bucketKey(row), row]));
  const changed: QueueBucket[] = [];
  for (const previous of existing) {
    if (previous.source !== 'trae' || ![TRAE_USAGE_COLLECTOR, 'trae-ide', ''].includes(previous.collector ?? '') || previous.hour_start < since) continue;
    const next = replacement.get(bucketKey(previous)) ?? {
      ...previous, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0, total_tokens: 0, conversation_count: 0, reported_cost_usd: 0, local_metrics: localEvidence(0),
    };
    replacement.delete(bucketKey(previous));
    if (JSON.stringify(next) !== JSON.stringify(previous)) changed.push(next);
  }
  return [...changed, ...replacement.values()];
}

type TraeSyncState = { identity?: string; attemptIdentity: string; since: string; attemptedAt: number };

export async function syncTraeApi(dataDir: string, statsSince: string, minIntervalMs = 0): Promise<{ ownsGlobal: boolean; result: SyncResult }> {
  const result: SyncResult = { source: 'trae', eventsParsed: 0, filesProcessed: 0, bucketsWritten: 0, writtenBuckets: [] };
  // Kept outside parser cursors: range backfills clear cursors.json.
  const statePath = join(dataDir, 'trae-usage-state.json');
  let previous: TraeSyncState | undefined;
  try { previous = JSON.parse(await readFile(statePath, 'utf8')) as TraeSyncState; } catch { /* first sync */ }
  const saveState = async (state: TraeSyncState) => {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, statePath);
  };
  const installed = hasTraeGlobalStorage();
  if (!installed && !previous) return { ownsGlobal: false, result };
  let ownsGlobal = Boolean(previous?.identity);
  try {
    const account = await readTraeAccount();
    if (!account) {
      result.error = 'Trae 国际版未登录，请打开 Trae 后登录；官网用量与数据库密钥无关。';
      return { ownsGlobal, result };
    }
    ownsGlobal = true;
    if (previous?.attemptIdentity === account.identity && previous.since === statsSince && Date.now() - previous.attemptedAt < minIntervalMs) return { ownsGlobal, result: { ...result, skipped: true } };
    // Persist backoff on failures too. Do not persist credentials or raw sessions.
    const state: TraeSyncState = { identity: previous?.identity, attemptIdentity: account.identity, since: statsSince, attemptedAt: Date.now() };
    await saveState(state);
    const fresh = await fetchTraeUsage(account, statsSince);
    if ((await readTraeAccount())?.identity !== account.identity) throw new Error('TRAE_ACCOUNT_CHANGED');
    const existing = await loadBucketsForRange(dataDir, new Date(0).toISOString());
    const changedAccount = previous?.identity !== undefined && previous.identity !== account.identity;
    const changes = replaceTraeSnapshot(existing, fresh, changedAccount ? new Date(0).toISOString() : statsSince);
    await appendBuckets(dataDir, changes);
    await saveState({ ...state, identity: account.identity });
    result.writtenBuckets = changes; result.bucketsWritten = changes.length; result.eventsParsed = fresh.length; result.filesProcessed = 1;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    result.error = code === 'TRAE_AUTH_EXPIRED' ? 'Trae 国际版登录已过期，请在 Trae 中重新登录。'
      : code === 'TRAE_CACHE_WRITE_UNVERIFIED' ? 'Trae 返回了尚未验证的缓存 Token 口径，已保留上次用量。'
      : '暂时无法读取 Trae 国际版官网用量，已保留上次数据。请检查网络及 Trae 登录状态。';
  }
  return { ownsGlobal, result };
}

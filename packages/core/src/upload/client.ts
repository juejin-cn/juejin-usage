import { randomUUID } from 'node:crypto';

import { aggregateForIngest } from '../aggregate.js';
import {
  resolveLinkedUserId,
  setLastUploadAt,
} from '../config.js';
import { appendJsonLog } from '../debug-log.js';
import { uploadLogPath } from '../paths.js';
import { loadBucketsForRange } from '../queue/index.js';
import { ingestBucketKey } from '../queue/keys.js';
import type { IngestBucket, QueueBucket, SyncStatus, TudConfig } from '../types.js';
import {
  BACKFILL_BATCH_LIMIT,
  BACKFILL_GAP_MS,
  applyBackfillFailure,
  applyIngestHold,
  earliestRetryMs,
  enqueueBackfillKeys,
  hourStartFromIngestKey,
  productWindowSinceIso,
  pruneBackfillItems,
  removeBackfillKeys,
  selectDrainBatch,
  shouldCommitBackfillBatch,
  splitLiveAndBackfill,
} from './backfill.js';
import { bucketToIngestEvent } from './events.js';
import {
  clearUploadSlot,
  commitBucketHashes,
  findUploadDelta,
  getUploadSlot,
  loadUploadStateFile,
  normalizeApiUrl,
  saveUploadStateFile,
  setUploadSlot,
  type UploadSlotState,
  type UploadStateFileV2,
} from './state.js';
import { maxIso } from './window.js';

const CLIENT_VERSION = 'jusage-1.0.0';

export interface UploadResult {
  uploaded: number;
  accepted: number;
  duplicate: number;
  skipped: number;
  /** HTTP POST count (batches). */
  requestCount: number;
  backfillEnqueued?: number;
}

export interface UploadOptions {
  /** Skip juejin.enabled check (for `jusage upload`). */
  force?: boolean;
  /**
   * Buckets appended in the latest sync. When the current slot already
   * has entries, only these keys are diffed instead of scanning all queue files.
   */
  recentBuckets?: QueueBucket[];
  /** Always scan full queue history (default for `jusage upload`). */
  fullScan?: boolean;
  /** Clear the current (apiUrl, deviceId) slot and re-diff. */
  reconcile?: boolean;
  /** Do not start the background drain loop (tests / caller will drain). */
  skipDrain?: boolean;
}

export interface RemoteUploadWatermark {
  ingestMinOccurredAt: string | null;
  dataThrough: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const uploadLocks = new Map<string, Promise<unknown>>();

async function withUploadLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = uploadLocks.get(dataDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  uploadLocks.set(
    dataDir,
    prev.then(
      () => gate,
      () => gate,
    ),
  );
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function postBatch(
  apiUrl: string,
  token: string,
  deviceId: string,
  events: NonNullable<ReturnType<typeof bucketToIngestEvent>>[],
): Promise<{ accepted: number; duplicate: number; reportId: string }> {
  const payload = {
    schema_version: 1,
    client_version: CLIENT_VERSION,
    device_id: deviceId,
    sent_at: new Date().toISOString(),
    events,
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${apiUrl}/v1/model-usage/reports`, {
      method: 'POST',
      headers: {
        'x-user-id': token,
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`上报失败 ${res.status}: ${text.slice(0, 200)}`);
    }

    let body: {
      success?: boolean;
      message?: string;
      data?: { accepted_count?: number; duplicate_count?: number; report_id?: string };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`上报响应解析失败: ${text.slice(0, 200)}`);
    }

    if (!body.success || !body.data) {
      throw new Error(body.message ?? `上报失败 ${res.status}`);
    }

    return {
      accepted: body.data.accepted_count ?? 0,
      duplicate: body.data.duplicate_count ?? 0,
      reportId: body.data.report_id ?? '',
    };
  }

  throw new Error('上报失败 429: rate limit exceeded');
}

/**
 * Fetch per-device upload watermark from Server sync-status.
 * On failure, returns nulls: live upload still uses local statsSince;
 * backfill holds until ingestMin is known.
 */
export async function fetchRemoteUploadWatermark(
  apiUrl: string,
  token: string,
  deviceId: string,
): Promise<RemoteUploadWatermark> {
  const url = new URL(`${normalizeApiUrl(apiUrl)}/functions/tud-sync-status`);
  url.searchParams.set('deviceId', deviceId);

  try {
    const res = await fetch(url, {
      headers: {
        'x-user-id': token,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return { ingestMinOccurredAt: null, dataThrough: null };
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: SyncStatus & { ingestMinOccurredAt?: string | null };
    };
    if (!body.success || !body.data) {
      return { ingestMinOccurredAt: null, dataThrough: null };
    }
    return {
      ingestMinOccurredAt: body.data.ingestMinOccurredAt ?? null,
      dataThrough: body.data.lastUploadAt ?? null,
    };
  } catch {
    return { ingestMinOccurredAt: null, dataThrough: null };
  }
}

function uploadTarget(
  config: TudConfig,
  force?: boolean,
): { apiUrl: string; token: string; deviceId: string } | null {
  if (!force && !config.juejin.enabled) return null;
  const apiUrl = normalizeApiUrl(config.juejin.apiUrl ?? '');
  const token = config.juejin.token?.trim();
  const deviceId = config.deviceId?.trim();
  if (!apiUrl || !deviceId || !token) return null;
  if (!resolveLinkedUserId(deviceId, token)) return null;
  return { apiUrl, token, deviceId };
}

function loadSinceIso(config: TudConfig, nowMs = Date.now()): string {
  const productSince = productWindowSinceIso(nowMs);
  return maxIso(config.statsSince, productSince) ?? productSince;
}

async function persistSlot(
  dataDir: string,
  file: UploadStateFileV2,
  apiUrl: string,
  deviceId: string,
  slot: UploadSlotState,
): Promise<UploadStateFileV2> {
  const next = setUploadSlot(file, apiUrl, deviceId, slot);
  await saveUploadStateFile(dataDir, next);
  return next;
}

export async function uploadToServer(
  dataDir: string,
  config: TudConfig,
  options?: UploadOptions,
): Promise<UploadResult | null> {
  const logPath = uploadLogPath(dataDir);
  const target = uploadTarget(config, options?.force);
  if (!options?.force && !config.juejin.enabled) {
    return null;
  }
  if (!target) {
    const reason = !config.juejin.apiUrl?.trim()
      ? 'missing_api_url'
      : !config.deviceId?.trim()
        ? 'missing_device_id'
        : !resolveLinkedUserId(config.deviceId, config.juejin.token)
          ? 'missing_linked_user'
          : 'missing_token';
    await appendJsonLog(logPath, { event: 'skip', reason });
    return null;
  }

  const { apiUrl, token, deviceId } = target;
  const nowMs = Date.now();
  const loadSince = loadSinceIso(config, nowMs);

  const result = await withUploadLock(dataDir, async () => {
    let file = await loadUploadStateFile(dataDir);
    if (options?.reconcile) {
      file = clearUploadSlot(file, apiUrl, deviceId);
      await appendJsonLog(logPath, {
        event: 'reconcile',
        reason: 'upload_slot_reset',
        apiUrl,
        deviceId,
      });
    }

    let slot: UploadSlotState = getUploadSlot(file, apiUrl, deviceId);
    let hasPriorUpload = Object.keys(slot.buckets).length > 0;

    const watermark = await fetchRemoteUploadWatermark(apiUrl, token, deviceId);

    if (hasPriorUpload && watermark.ingestMinOccurredAt && !watermark.dataThrough) {
      file = clearUploadSlot(file, apiUrl, deviceId);
      slot = getUploadSlot(file, apiUrl, deviceId);
      hasPriorUpload = false;
      await appendJsonLog(logPath, {
        event: 'reconcile',
        reason: 'remote_empty_for_device',
        apiUrl,
        deviceId,
      });
    }

    const enqueuedSince = slot.backfill?.enqueuedSince ?? null;
    const windowExpanded =
      !enqueuedSince || Date.parse(loadSince) < Date.parse(enqueuedSince);

    let useIncremental =
      !options?.fullScan &&
      !windowExpanded &&
      hasPriorUpload &&
      options?.recentBuckets !== undefined;

    // Empty array means this sync wrote nothing — skip ingest entirely.
    // (undefined recentBuckets still means "caller doesn't know", so full scan.)
    if (useIncremental && options!.recentBuckets!.length === 0) {
      await appendJsonLog(logPath, {
        event: 'skip',
        reason: 'no_recent_buckets',
        totalBuckets: 0,
      });
      return {
        uploaded: 0,
        accepted: 0,
        duplicate: 0,
        skipped: 0,
        requestCount: 0,
        backfillEnqueued: 0,
      };
    }

    const loaded = useIncremental
      ? aggregateForIngest(options!.recentBuckets!)
      : aggregateForIngest(await loadBucketsForRange(dataDir, loadSince));

    const delta = findUploadDelta(loaded, slot);
    const { live, backfill } = splitLiveAndBackfill(delta, slot, nowMs);
    const pendingKeys = new Set(
      (slot.backfill?.items ?? []).map((item) => item.key),
    );
    const liveNow = live.filter((bucket) => !pendingKeys.has(ingestBucketKey(bucket)));

    let enqueued = 0;
    if (backfill.length > 0 || windowExpanded) {
      const queued = enqueueBackfillKeys(
        slot,
        backfill.map((bucket) => ingestBucketKey(bucket)),
        useIncremental ? enqueuedSince : loadSince,
      );
      slot = queued.slot;
      enqueued = queued.added;
      file = await persistSlot(dataDir, file, apiUrl, deviceId, slot);
      if (enqueued > 0) {
        await appendJsonLog(logPath, {
          event: 'backfill_enqueue',
          added: enqueued,
          total: slot.backfill?.items.length ?? 0,
          loadSince,
        });
      }
    }

    if (liveNow.length === 0 && enqueued === 0) {
      await appendJsonLog(logPath, {
        event: 'skip',
        reason: 'no_delta',
        totalBuckets: loaded.length,
        mode: useIncremental ? 'incremental' : 'full',
        loadSince,
      });
      return {
        uploaded: 0,
        accepted: 0,
        duplicate: 0,
        skipped: 0,
        requestCount: 0,
        backfillEnqueued: 0,
      };
    }

    const events = liveNow
      .map((bucket) => bucketToIngestEvent(bucket, deviceId))
      .filter((ev): ev is NonNullable<typeof ev> => ev !== null);
    const skipped = liveNow.length - events.length;
    let acceptedTotal = 0;
    let duplicateTotal = 0;
    let requestCount = 0;

    if (events.length > 0) {
      await appendJsonLog(logPath, {
        event: 'start',
        mode: useIncremental ? 'incremental' : 'full',
        lane: 'live',
        deltaBuckets: liveNow.length,
        events: events.length,
        skipped,
        loadSince,
      });

      try {
        for (let i = 0; i < events.length; i += BACKFILL_BATCH_LIMIT) {
          const batch = events.slice(i, i + BACKFILL_BATCH_LIMIT);
          const result = await postBatch(apiUrl, token, deviceId, batch);
          requestCount += 1;
          acceptedTotal += result.accepted;
          duplicateTotal += result.duplicate;
          await appendJsonLog(logPath, {
            event: 'batch',
            lane: 'live',
            batchIndex: Math.floor(i / BACKFILL_BATCH_LIMIT) + 1,
            batchSize: batch.length,
            accepted: result.accepted,
            duplicate: result.duplicate,
            reportId: result.reportId,
          });
        }
      } catch (err) {
        await appendJsonLog(logPath, {
          event: 'error',
          lane: 'live',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (acceptedTotal === 0 && events.length > 0 && duplicateTotal === 0) {
        await appendJsonLog(logPath, {
          event: 'error',
          error: 'server rejected all events (accepted=0)',
          uploaded: events.length,
          duplicate: duplicateTotal,
        });
        throw new Error(
          `上报未生效：${events.length} 条事件均被 Server 忽略（accepted=0）。` +
            '请确认 Server 已更新，或运行 jusage upload --force --reconcile 重新对齐。',
        );
      }

      slot = commitBucketHashes(slot, liveNow);
      slot = {
        ...slot,
        backfill: {
          items: removeBackfillKeys(
            slot.backfill?.items ?? [],
            liveNow.map((bucket) => ingestBucketKey(bucket)),
          ),
          enqueuedSince: slot.backfill?.enqueuedSince ?? null,
        },
      };
      file = await persistSlot(dataDir, file, apiUrl, deviceId, slot);
      await setLastUploadAt(dataDir, config);
    }

    await appendJsonLog(logPath, {
      event: 'done',
      lane: 'live',
      uploaded: events.length,
      accepted: acceptedTotal,
      duplicate: duplicateTotal,
      backfillEnqueued: enqueued,
    });

    return {
      uploaded: events.length,
      accepted: acceptedTotal,
      duplicate: duplicateTotal,
      skipped,
      requestCount,
      backfillEnqueued: enqueued,
    };
  });

  if (!options?.skipDrain) kickBackfillDrain(dataDir, () => config);
  return result;
}

export interface DrainRoundResult {
  idle: boolean;
  waitMs: number;
  posted: number;
  held: number;
}

export async function drainBackfillRound(
  dataDir: string,
  config: TudConfig,
  opts?: { nowMs?: number },
): Promise<DrainRoundResult> {
  const logPath = uploadLogPath(dataDir);
  const target = uploadTarget(config, false);
  if (!target) {
    return { idle: true, waitMs: 0, posted: 0, held: 0 };
  }
  const { apiUrl, token, deviceId } = target;
  const nowMs = opts?.nowMs ?? Date.now();
  const productSince = productWindowSinceIso(nowMs);

  const prepared = await withUploadLock(dataDir, async () => {
    const file = await loadUploadStateFile(dataDir);
    const slot = getUploadSlot(file, apiUrl, deviceId);
    const pruned = pruneBackfillItems(slot.backfill?.items ?? [], productSince);
    if (pruned.kept.length === 0) {
      if (pruned.dropped > 0) {
        await persistSlot(dataDir, file, apiUrl, deviceId, {
          buckets: slot.buckets,
          backfill: {
            items: [],
            enqueuedSince: slot.backfill?.enqueuedSince ?? null,
          },
        });
      }
      return {
        send: [] as typeof pruned.kept,
        held: 0,
        remaining: 0,
        ingestMin: null as string | null,
        usedFallback: false,
      };
    }
    const watermark = await fetchRemoteUploadWatermark(apiUrl, token, deviceId);
    const usedFallback = !watermark.ingestMinOccurredAt;
    const ingestMinIso = watermark.ingestMinOccurredAt ?? productSince;
    if (usedFallback) {
      await appendJsonLog(logPath, {
        event: 'watermark_fallback',
        lane: 'backfill',
        reason: 'ingestMin_missing',
        ingestMin: ingestMinIso,
      });
    }
    const selected = selectDrainBatch(pruned.kept, {
      ingestMinIso,
      productSinceIso: productSince,
      nowMs,
    });

    const items = [
      ...selected.send,
      ...applyIngestHold(selected.hold, nowMs),
      ...selected.rest,
    ].sort((a, b) => {
      const ah = hourStartFromIngestKey(a.key) ?? a.key;
      const bh = hourStartFromIngestKey(b.key) ?? b.key;
      return ah.localeCompare(bh);
    });

    const nextSlot: UploadSlotState = {
      buckets: slot.buckets,
      backfill: {
        items,
        enqueuedSince: slot.backfill?.enqueuedSince ?? null,
      },
    };
    await persistSlot(dataDir, file, apiUrl, deviceId, nextSlot);

    return {
      send: selected.send,
      held: selected.hold.length,
      remaining: items.length,
      ingestMin: ingestMinIso,
      usedFallback,
    };
  });

  if (prepared.send.length === 0) {
    if (prepared.remaining === 0) {
      return { idle: true, waitMs: 0, posted: 0, held: prepared.held };
    }
    await appendJsonLog(logPath, {
      event: 'backfill_hold',
      lane: 'backfill',
      reason: prepared.ingestMin ? 'below_ingestMin_or_retry' : 'ingestMin_missing',
      held: prepared.held,
      remaining: prepared.remaining,
      ingestMin: prepared.ingestMin,
    });
    const file = await loadUploadStateFile(dataDir);
    const slot = getUploadSlot(file, apiUrl, deviceId);
    const waitFrom = earliestRetryMs(slot.backfill?.items ?? [], nowMs);
    const waitMs = waitFrom != null ? Math.max(1_000, waitFrom - nowMs) : BACKFILL_GAP_MS;
    return { idle: false, waitMs, posted: 0, held: prepared.held };
  }

  const hydrateSince =
    hourStartFromIngestKey(prepared.send[0]!.key) ?? productSince;
  const rows = aggregateForIngest(await loadBucketsForRange(dataDir, hydrateSince));
  const byKey = new Map(rows.map((bucket) => [ingestBucketKey(bucket), bucket]));
  const toSend: IngestBucket[] = [];
  const missing: string[] = [];
  for (const item of prepared.send) {
    const bucket = byKey.get(item.key);
    if (bucket) toSend.push(bucket);
    else missing.push(item.key);
  }

  const events = toSend
    .map((bucket) => bucketToIngestEvent(bucket, deviceId))
    .filter((ev): ev is NonNullable<typeof ev> => ev !== null);

  await appendJsonLog(logPath, {
    event: 'start',
    lane: 'backfill',
    events: events.length,
    missing: missing.length,
    ingestMin: prepared.ingestMin,
  });

  let accepted = 0;
  let duplicate = 0;
  let failed = false;
  if (events.length > 0) {
    try {
      const posted = await postBatch(apiUrl, token, deviceId, events);
      accepted = posted.accepted;
      duplicate = posted.duplicate;
      failed = !shouldCommitBackfillBatch({
        accepted,
        duplicate,
        ingestMinIso: prepared.ingestMin,
        eventHourStarts: events.map((ev) => ev.occurred_at),
      });
      // sync-status 失败时用本地 90d 窗发送；全是 duplicate 不能当成功，
      // 否则 15d 软丢弃会再次把 hash 误标成已上报。
      if (prepared.usedFallback && accepted === 0) failed = true;
    } catch (err) {
      failed = true;
      await appendJsonLog(logPath, {
        event: 'error',
        lane: 'backfill',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (toSend.length > 0) {
    failed = true;
  }

  await withUploadLock(dataDir, async () => {
    const file = await loadUploadStateFile(dataDir);
    let slot = getUploadSlot(file, apiUrl, deviceId);
    let items = slot.backfill?.items ?? [];
    items = removeBackfillKeys(items, missing);
    const sentKeys = toSend.map((bucket) => ingestBucketKey(bucket));
    if (failed) {
      const failedItems = items.filter((item) => sentKeys.includes(item.key));
      const others = items.filter((item) => !sentKeys.includes(item.key));
      items = [...others, ...applyBackfillFailure(failedItems, nowMs)];
    } else {
      items = removeBackfillKeys(items, sentKeys);
      slot = commitBucketHashes(slot, toSend);
      await setLastUploadAt(dataDir, config);
    }
    slot = {
      ...slot,
      backfill: {
        items,
        enqueuedSince: slot.backfill?.enqueuedSince ?? null,
      },
    };
    await persistSlot(dataDir, file, apiUrl, deviceId, slot);
  });

  await appendJsonLog(logPath, {
    event: failed ? 'backfill_retry' : 'batch',
    lane: 'backfill',
    accepted,
    duplicate,
    posted: events.length,
    ingestMin: prepared.ingestMin,
    reason: failed && accepted === 0 && duplicate > 0 ? 'floor_duplicate' : undefined,
  });

  return {
    idle: false,
    waitMs: BACKFILL_GAP_MS,
    posted: failed ? 0 : events.length,
    held: prepared.held,
  };
}

interface DrainHandle {
  dataDir: string;
  getConfig: () => TudConfig;
  running: boolean;
  loop: Promise<void> | null;
}

let drainHandle: DrainHandle | null = null;

async function runDrainLoop(handle: DrainHandle): Promise<void> {
  while (handle.running) {
    const config = handle.getConfig();
    const result = await drainBackfillRound(handle.dataDir, config);
    if (!handle.running) return;
    if (result.idle) return;
    await sleep(result.waitMs);
  }
}

/** Start / continue background backfill drain for this dataDir. */
export function kickBackfillDrain(
  dataDir: string,
  getConfig: () => TudConfig,
): void {
  if (drainHandle && drainHandle.dataDir === dataDir && drainHandle.loop) {
    return;
  }
  stopBackfillDrain();
  const handle: DrainHandle = {
    dataDir,
    getConfig,
    running: true,
    loop: null,
  };
  drainHandle = handle;
  handle.loop = runDrainLoop(handle).finally(() => {
    if (drainHandle === handle) {
      handle.loop = null;
      handle.running = false;
    }
  });
}

export function stopBackfillDrain(): void {
  if (!drainHandle) return;
  drainHandle.running = false;
  drainHandle = null;
}

/** Drain until the queue is empty or only future-retry / ingest-hold items remain. */
export async function drainBackfillUntilIdle(
  dataDir: string,
  config: TudConfig,
  opts?: { maxRounds?: number; nowMs?: number },
): Promise<void> {
  const maxRounds = opts?.maxRounds ?? 10_000;
  for (let i = 0; i < maxRounds; i += 1) {
    const result = await drainBackfillRound(dataDir, config, { nowMs: opts?.nowMs });
    if (result.idle) return;
    if (result.posted === 0 && result.waitMs > BACKFILL_GAP_MS) return;
    if (result.waitMs > 0) await sleep(result.waitMs);
  }
}

export async function maybeUploadAfterSync(
  dataDir: string,
  config: TudConfig,
  recentBuckets?: QueueBucket[],
): Promise<void> {
  try {
    await uploadToServer(dataDir, config, { recentBuckets });
  } catch (err) {
    console.warn('云端上报失败:', err instanceof Error ? err.message : err);
    kickBackfillDrain(dataDir, () => config);
  }
}

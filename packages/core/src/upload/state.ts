import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IngestBucket } from '../types.js';
import { ingestBucketKey } from '../queue/keys.js';

export interface BackfillItem {
  key: string;
  attempts: number;
  nextRetryAt: string | null;
}

export interface BackfillState {
  items: BackfillItem[];
  /** Product-window floor used the last time we enqueued a full delta. */
  enqueuedSince?: string | null;
}

export interface UploadSlotState {
  buckets: Record<string, string>;
  backfill?: BackfillState;
  /** Set when live ingest fails; next upload forces a full queue scan. */
  needsFullScan?: boolean;
}

/** v2: per-(apiUrl, deviceId) slots so remotes and machines do not share pointers. */
export interface UploadStateFileV2 {
  version: 2;
  remotes: Record<string, { devices: Record<string, UploadSlotState> }>;
}

/** Legacy v1 flat hash map. */
export interface UploadStateFileV1 {
  buckets: Record<string, string>;
}

export type UploadStateFile = UploadStateFileV2;

export function uploadStatePath(dataDir: string): string {
  return join(dataDir, 'upload.state.json');
}

export function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '');
}

export function bucketHash(bucket: IngestBucket): string {
  const payload = [
    bucket.input_tokens,
    bucket.output_tokens,
    bucket.cached_input_tokens,
    bucket.cache_creation_input_tokens,
    bucket.reasoning_output_tokens,
    bucket.total_tokens,
    bucket.conversation_count,
    bucket.reported_cost_usd ?? '',
  ].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function emptyV2(): UploadStateFileV2 {
  return { version: 2, remotes: {} };
}

function cloneBackfill(backfill: BackfillState | undefined): BackfillState {
  return {
    items: (backfill?.items ?? []).map((item) => ({ ...item })),
    enqueuedSince: backfill?.enqueuedSince ?? null,
  };
}

function cloneSlot(slot: UploadSlotState | undefined): UploadSlotState {
  return {
    buckets: { ...(slot?.buckets ?? {}) },
    backfill: cloneBackfill(slot?.backfill),
    ...(slot?.needsFullScan ? { needsFullScan: true } : {}),
  };
}

function isV2(parsed: unknown): parsed is UploadStateFileV2 {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as UploadStateFileV2).version === 2 &&
    typeof (parsed as UploadStateFileV2).remotes === 'object' &&
    (parsed as UploadStateFileV2).remotes !== null
  );
}

/** Load full file; migrates v1 `{ buckets }` into an empty v2 shell (caller picks slot). */
export async function loadUploadStateFile(dataDir: string): Promise<UploadStateFileV2> {
  const path = uploadStatePath(dataDir);
  if (!existsSync(path)) return emptyV2();
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isV2(parsed)) {
      return {
        version: 2,
        remotes: parsed.remotes ?? {},
      };
    }
    // v1: discard flat buckets — they are not bound to apiUrl/deviceId.
    // Catch-up uses remote dataThrough watermark instead of carrying stale hashes.
    return emptyV2();
  } catch {
    return emptyV2();
  }
}

export async function saveUploadStateFile(
  dataDir: string,
  state: UploadStateFileV2,
): Promise<void> {
  await writeFile(
    uploadStatePath(dataDir),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

export function getUploadSlot(
  state: UploadStateFileV2,
  apiUrl: string,
  deviceId: string,
): UploadSlotState {
  const url = normalizeApiUrl(apiUrl);
  const remote = state.remotes[url];
  return cloneSlot(remote?.devices?.[deviceId]);
}

export function setUploadSlot(
  state: UploadStateFileV2,
  apiUrl: string,
  deviceId: string,
  slot: UploadSlotState,
): UploadStateFileV2 {
  const url = normalizeApiUrl(apiUrl);
  const remotes = { ...state.remotes };
  const prevRemote = remotes[url] ?? { devices: {} };
  remotes[url] = {
    devices: {
      ...prevRemote.devices,
      [deviceId]: cloneSlot(slot),
    },
  };
  return { version: 2, remotes };
}

export function clearUploadSlot(
  state: UploadStateFileV2,
  apiUrl: string,
  deviceId: string,
): UploadStateFileV2 {
  return setUploadSlot(state, apiUrl, deviceId, {
    buckets: {},
    backfill: { items: [] },
  });
}

/** @deprecated Prefer getUploadSlot — kept for callers that still expect flat buckets. */
export async function loadUploadState(dataDir: string): Promise<UploadSlotState> {
  const file = await loadUploadStateFile(dataDir);
  const urls = Object.keys(file.remotes);
  if (urls.length !== 1) return { buckets: {}, backfill: { items: [] } };
  const devices = file.remotes[urls[0]!]?.devices ?? {};
  const ids = Object.keys(devices);
  if (ids.length !== 1) return { buckets: {}, backfill: { items: [] } };
  return getUploadSlot(file, urls[0]!, ids[0]!);
}

/** @deprecated Prefer saveUploadStateFile + setUploadSlot. */
export async function saveUploadState(
  dataDir: string,
  slot: UploadSlotState,
): Promise<void> {
  await saveUploadStateFile(dataDir, {
    version: 2,
    remotes: {
      _legacy: { devices: { _legacy: cloneSlot(slot) } },
    },
  });
}

export function diffUploadBuckets(
  buckets: IngestBucket[],
  state: UploadSlotState,
): { delta: IngestBucket[]; nextState: UploadSlotState } {
  const nextState: UploadSlotState = cloneSlot(state);
  const delta: IngestBucket[] = [];

  for (const bucket of buckets) {
    const key = ingestBucketKey(bucket);
    const hash = bucketHash(bucket);
    if (nextState.buckets[key] === hash) continue;
    delta.push(bucket);
    nextState.buckets[key] = hash;
  }

  return { delta, nextState };
}

export function findUploadDelta(
  buckets: IngestBucket[],
  state: UploadSlotState,
): IngestBucket[] {
  const delta: IngestBucket[] = [];
  for (const bucket of buckets) {
    const key = ingestBucketKey(bucket);
    if (state.buckets[key] === bucketHash(bucket)) continue;
    delta.push(bucket);
  }
  return delta;
}

export function commitBucketHashes(
  state: UploadSlotState,
  buckets: IngestBucket[],
): UploadSlotState {
  const next = cloneSlot(state);
  for (const bucket of buckets) {
    next.buckets[ingestBucketKey(bucket)] = bucketHash(bucket);
  }
  return next;
}

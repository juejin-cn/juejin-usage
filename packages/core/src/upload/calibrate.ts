import { randomUUID } from 'node:crypto';

import { aggregateForIngest } from '../aggregate.js';
import { resolveLinkedUserId } from '../config.js';
import { loadBucketsForRange } from '../queue/index.js';
import {
  DEFAULT_STATS_TIMEZONE,
  addLocalDays,
  localDateAndHour,
} from '../timezone.js';
import type { TudConfig } from '../types.js';
import { bucketToIngestEvent, type IngestEventPayload } from './events.js';
import {
  commitBucketHashes,
  getUploadSlot,
  loadUploadStateFile,
  normalizeApiUrl,
  saveUploadStateFile,
  setUploadSlot,
} from './state.js';
import { productWindowSinceIso } from './backfill.js';
import { maxIso } from './window.js';

const CLIENT_VERSION = 'jusage-1.0.0';
const MAX_EVENTS_PER_RECONCILE = 500;
const SHANGHAI_OFFSET = '+08:00';

export type CalibrateRowKind =
  | 'online_missing'
  | 'online_only'
  | 'mismatch';

export type DayDiffKind = CalibrateRowKind;

export interface CalibrateUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CalibrateEventRow {
  event_id: string;
  occurred_at: string;
  integration: string;
  collector: string;
  model: string;
  usage: CalibrateUsage;
  conversations_count: number;
  reported_cost_usd: number | null;
}

export interface CalibrateRowDiff {
  kind: CalibrateRowKind;
  event_id: string;
  occurred_at: string;
  date: string;
  integration: string;
  collector: string;
  model: string;
  local: CalibrateEventRow | null;
  remote: CalibrateEventRow | null;
  tokenDelta: number;
  reportedCostDeltaUsd: number | null;
  outOfIngestWindow: boolean;
}

export interface DayDiffSummary {
  date: string;
  kinds: DayDiffKind[];
  localOnlyRows: number;
  onlineOnlyRows: number;
  mismatchRows: number;
  tokenDelta: number;
  reportedCostDeltaUsd: number | null;
  outOfIngestWindow: boolean;
  rows: CalibrateRowDiff[];
}

export interface CalibratePreviewSummary {
  diffDayCount: number;
  onlineMissingDays: number;
  onlineMissingRows: number;
  onlineMissingTokens: number;
  onlineOnlyDays: number;
  onlineOnlyRows: number;
  onlineOnlyTokens: number;
  mismatchDays: number;
  mismatchRows: number;
  mismatchTokenDelta: number;
  mismatchReportedCostDeltaUsd: number | null;
}

export interface UsageDeviceInfo {
  device_id: string;
  event_count: number;
  first_occurred_at: string | null;
  last_occurred_at: string | null;
  last_upload_at: string | null;
}

export interface CalibratePreviewResult {
  deviceId: string;
  ingestMinOccurredAt: string | null;
  from: string;
  to: string;
  days: DayDiffSummary[];
  summary: CalibratePreviewSummary;
  otherOnlineDevices: UsageDeviceInfo[];
  rowDiffs: CalibrateRowDiff[];
}

export interface ReconcileBatch {
  device_id: string;
  mode: 'replace_window';
  from: string;
  to: string;
  schema_version: 1;
  client_version: string;
  events: IngestEventPayload[];
}

export interface ReconcileBatchResult {
  deleted_count: number;
  upserted_count: number;
  floored_count: number;
  received_at: string;
}

function authHeaders(token: string): HeadersInit {
  return {
    'x-user-id': token,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

function totalTokens(usage: CalibrateUsage): number {
  return (
    usage.input_tokens +
    usage.cached_input_tokens +
    usage.cache_creation_input_tokens +
    usage.output_tokens +
    usage.reasoning_output_tokens
  );
}

function normalizeReportedCost(
  value: number | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

function reportedCostEqual(
  a: number | null | undefined,
  b: number | null | undefined,
): boolean {
  const left = normalizeReportedCost(a);
  const right = normalizeReportedCost(b);
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return Math.abs(left - right) < 1e-9;
}

function usageEqual(a: CalibrateUsage, b: CalibrateUsage): boolean {
  return (
    a.input_tokens === b.input_tokens &&
    a.cached_input_tokens === b.cached_input_tokens &&
    a.cache_creation_input_tokens === b.cache_creation_input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.reasoning_output_tokens === b.reasoning_output_tokens
  );
}

export function shanghaiDayBounds(date: string): { from: string; to: string } {
  const next = addLocalDays(date, 1);
  return {
    from: new Date(`${date}T00:00:00${SHANGHAI_OFFSET}`).toISOString(),
    to: new Date(`${next}T00:00:00${SHANGHAI_OFFSET}`).toISOString(),
  };
}

function toCalibrateRow(event: IngestEventPayload): CalibrateEventRow {
  return {
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    integration: event.integration,
    collector: event.collector,
    model: event.model,
    usage: { ...event.usage },
    conversations_count: Math.max(1, event.conversations_count ?? 1),
    reported_cost_usd: normalizeReportedCost(event.reported_cost_usd),
  };
}

export function diffCalibrateRows(
  localRows: ReadonlyArray<CalibrateEventRow>,
  remoteRows: ReadonlyArray<CalibrateEventRow>,
  ingestMinOccurredAt: string | null,
): CalibrateRowDiff[] {
  const ingestMinMs = ingestMinOccurredAt
    ? Date.parse(ingestMinOccurredAt)
    : Number.NaN;
  const localById = new Map(localRows.map((row) => [row.event_id, row]));
  const remoteById = new Map(remoteRows.map((row) => [row.event_id, row]));
  const ids = new Set([...localById.keys(), ...remoteById.keys()]);
  const diffs: CalibrateRowDiff[] = [];

  for (const eventId of ids) {
    const local = localById.get(eventId) ?? null;
    const remote = remoteById.get(eventId) ?? null;
    const occurredAt = local?.occurred_at ?? remote!.occurred_at;
    const occurredMs = Date.parse(occurredAt);
    const outOfIngestWindow =
      Number.isFinite(ingestMinMs) &&
      Number.isFinite(occurredMs) &&
      occurredMs < ingestMinMs;
    const date = localDateAndHour(occurredAt, DEFAULT_STATS_TIMEZONE).date;

    if (local && !remote) {
      diffs.push({
        kind: 'online_missing',
        event_id: eventId,
        occurred_at: occurredAt,
        date,
        integration: local.integration,
        collector: local.collector,
        model: local.model,
        local,
        remote: null,
        tokenDelta: totalTokens(local.usage),
        reportedCostDeltaUsd: local.reported_cost_usd,
        outOfIngestWindow,
      });
      continue;
    }
    if (!local && remote) {
      diffs.push({
        kind: 'online_only',
        event_id: eventId,
        occurred_at: occurredAt,
        date,
        integration: remote.integration,
        collector: remote.collector,
        model: remote.model,
        local: null,
        remote,
        tokenDelta: -totalTokens(remote.usage),
        reportedCostDeltaUsd:
          remote.reported_cost_usd == null ? null : -remote.reported_cost_usd,
        outOfIngestWindow,
      });
      continue;
    }
    if (
      local &&
      remote &&
      (!usageEqual(local.usage, remote.usage) ||
        !reportedCostEqual(local.reported_cost_usd, remote.reported_cost_usd))
    ) {
      const localCost = local.reported_cost_usd;
      const remoteCost = remote.reported_cost_usd;
      diffs.push({
        kind: 'mismatch',
        event_id: eventId,
        occurred_at: occurredAt,
        date,
        integration: local.integration,
        collector: local.collector,
        model: local.model,
        local,
        remote,
        tokenDelta: totalTokens(local.usage) - totalTokens(remote.usage),
        reportedCostDeltaUsd:
          localCost == null && remoteCost == null
            ? null
            : (localCost ?? 0) - (remoteCost ?? 0),
        outOfIngestWindow,
      });
    }
  }

  return diffs.sort((a, b) =>
    a.occurred_at < b.occurred_at
      ? -1
      : a.occurred_at > b.occurred_at
        ? 1
        : a.event_id.localeCompare(b.event_id),
  );
}

export function rollupDayDiffs(
  rowDiffs: ReadonlyArray<CalibrateRowDiff>,
): DayDiffSummary[] {
  const byDate = new Map<string, CalibrateRowDiff[]>();
  for (const row of rowDiffs) {
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }

  const days: DayDiffSummary[] = [];
  for (const [date, rows] of [...byDate.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const kinds = new Set<DayDiffKind>();
    let localOnlyRows = 0;
    let onlineOnlyRows = 0;
    let mismatchRows = 0;
    let tokenDelta = 0;
    let costDelta: number | null = null;
    let outOfIngestWindow = false;

    for (const row of rows) {
      kinds.add(row.kind);
      if (row.kind === 'online_missing') localOnlyRows += 1;
      if (row.kind === 'online_only') onlineOnlyRows += 1;
      if (row.kind === 'mismatch') mismatchRows += 1;
      tokenDelta += row.tokenDelta;
      if (row.reportedCostDeltaUsd != null) {
        costDelta = (costDelta ?? 0) + row.reportedCostDeltaUsd;
      }
      if (row.outOfIngestWindow) outOfIngestWindow = true;
    }

    days.push({
      date,
      kinds: [...kinds],
      localOnlyRows,
      onlineOnlyRows,
      mismatchRows,
      tokenDelta,
      reportedCostDeltaUsd: costDelta,
      outOfIngestWindow,
      rows,
    });
  }
  return days;
}

export function summarizeCalibrateDays(
  days: ReadonlyArray<DayDiffSummary>,
): CalibratePreviewSummary {
  let onlineMissingDays = 0;
  let onlineMissingRows = 0;
  let onlineMissingTokens = 0;
  let onlineOnlyDays = 0;
  let onlineOnlyRows = 0;
  let onlineOnlyTokens = 0;
  let mismatchDays = 0;
  let mismatchRows = 0;
  let mismatchTokenDelta = 0;
  let mismatchReportedCostDeltaUsd: number | null = null;

  for (const day of days) {
    if (day.kinds.includes('online_missing')) {
      onlineMissingDays += 1;
      onlineMissingRows += day.localOnlyRows;
      onlineMissingTokens += day.rows
        .filter((r) => r.kind === 'online_missing')
        .reduce((sum, r) => sum + Math.max(0, r.tokenDelta), 0);
    }
    if (day.kinds.includes('online_only')) {
      onlineOnlyDays += 1;
      onlineOnlyRows += day.onlineOnlyRows;
      onlineOnlyTokens += day.rows
        .filter((r) => r.kind === 'online_only')
        .reduce((sum, r) => sum + Math.max(0, -r.tokenDelta), 0);
    }
    if (day.kinds.includes('mismatch')) {
      mismatchDays += 1;
      mismatchRows += day.mismatchRows;
      for (const row of day.rows) {
        if (row.kind !== 'mismatch') continue;
        mismatchTokenDelta += row.tokenDelta;
        if (row.reportedCostDeltaUsd != null) {
          mismatchReportedCostDeltaUsd =
            (mismatchReportedCostDeltaUsd ?? 0) + row.reportedCostDeltaUsd;
        }
      }
    }
  }

  return {
    diffDayCount: days.length,
    onlineMissingDays,
    onlineMissingRows,
    onlineMissingTokens,
    onlineOnlyDays,
    onlineOnlyRows,
    onlineOnlyTokens,
    mismatchDays,
    mismatchRows,
    mismatchTokenDelta,
    mismatchReportedCostDeltaUsd,
  };
}

function calibrateTarget(
  config: TudConfig,
): { apiUrl: string; token: string; deviceId: string } | null {
  const apiUrl = normalizeApiUrl(config.juejin.apiUrl ?? '');
  const token = config.juejin.token?.trim();
  const deviceId = config.deviceId?.trim();
  if (!apiUrl || !deviceId || !token) return null;
  if (!resolveLinkedUserId(deviceId, token)) return null;
  return { apiUrl, token, deviceId };
}

export async function fetchUsageDevices(
  apiUrl: string,
  token: string,
): Promise<UsageDeviceInfo[]> {
  const res = await fetch(
    `${normalizeApiUrl(apiUrl)}/functions/tud-usage-devices`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) {
    throw new Error(`tud-usage-devices failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    success?: boolean;
    data?: { devices?: UsageDeviceInfo[] };
    message?: string;
  };
  if (!body.success || !body.data) {
    throw new Error(body.message || 'tud-usage-devices failed');
  }
  return body.data.devices ?? [];
}

export async function fetchAllDeviceEvents(
  apiUrl: string,
  token: string,
  deviceId: string,
  from: string,
  to: string,
): Promise<{
  events: CalibrateEventRow[];
  ingestMinOccurredAt: string | null;
  from: string;
  to: string;
}> {
  const events: CalibrateEventRow[] = [];
  let cursor: string | null = null;
  let ingestMinOccurredAt: string | null = null;
  let resolvedFrom = from;
  let resolvedTo = to;

  for (;;) {
    const url = new URL(
      `${normalizeApiUrl(apiUrl)}/functions/tud-usage-device-events`,
    );
    url.searchParams.set('deviceId', deviceId);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('limit', String(MAX_EVENTS_PER_RECONCILE));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      throw new Error(`tud-usage-device-events failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        events?: CalibrateEventRow[];
        next_cursor?: string | null;
        ingest_min_occurred_at?: string | null;
        from?: string;
        to?: string;
      };
      message?: string;
    };
    if (!body.success || !body.data) {
      throw new Error(body.message || 'tud-usage-device-events failed');
    }
    ingestMinOccurredAt = body.data.ingest_min_occurred_at ?? ingestMinOccurredAt;
    resolvedFrom = body.data.from ?? resolvedFrom;
    resolvedTo = body.data.to ?? resolvedTo;
    for (const event of body.data.events ?? []) {
      events.push({
        ...event,
        reported_cost_usd: normalizeReportedCost(event.reported_cost_usd),
        conversations_count: Math.max(1, event.conversations_count ?? 1),
      });
    }
    cursor = body.data.next_cursor ?? null;
    if (!cursor) break;
  }

  return { events, ingestMinOccurredAt, from: resolvedFrom, to: resolvedTo };
}

export async function loadLocalCalibrateEvents(
  dataDir: string,
  _config: TudConfig,
  deviceId: string,
  sinceIso: string,
): Promise<CalibrateEventRow[]> {
  const buckets = aggregateForIngest(
    await loadBucketsForRange(dataDir, sinceIso),
  );
  return buckets
    .map((bucket) => bucketToIngestEvent(bucket, deviceId))
    .filter((event): event is IngestEventPayload => event != null)
    .map(toCalibrateRow);
}

export async function buildCalibratePreview(
  dataDir: string,
  config: TudConfig,
): Promise<CalibratePreviewResult> {
  const target = calibrateTarget(config);
  if (!target) {
    throw new Error('云端同步未关联或缺少 apiUrl / token / deviceId');
  }
  const { apiUrl, token, deviceId } = target;
  const nowIso = new Date().toISOString();
  const sinceIso =
    maxIso(config.statsSince, productWindowSinceIso()) ??
    productWindowSinceIso();

  const [devices, localRows, remote] = await Promise.all([
    fetchUsageDevices(apiUrl, token),
    loadLocalCalibrateEvents(dataDir, config, deviceId, sinceIso),
    fetchAllDeviceEvents(apiUrl, token, deviceId, sinceIso, nowIso),
  ]);

  const rowDiffs = diffCalibrateRows(
    localRows,
    remote.events,
    remote.ingestMinOccurredAt,
  );
  const days = rollupDayDiffs(rowDiffs);
  return {
    deviceId,
    ingestMinOccurredAt: remote.ingestMinOccurredAt,
    from: remote.from,
    to: remote.to,
    days,
    summary: summarizeCalibrateDays(days),
    otherOnlineDevices: devices.filter((d) => d.device_id !== deviceId),
    rowDiffs,
  };
}

/**
 * Build replace_window batches for selected Shanghai calendar days.
 * Local full snapshot for each day (empty = clear online-only day).
 */
export function buildReconcileBatches(args: {
  deviceId: string;
  selectedDates: ReadonlyArray<string>;
  localRows: ReadonlyArray<CalibrateEventRow>;
}): ReconcileBatch[] {
  const selected = [...new Set(args.selectedDates)].sort();
  const byDate = new Map<string, CalibrateEventRow[]>();
  for (const row of args.localRows) {
    const date = localDateAndHour(row.occurred_at, DEFAULT_STATS_TIMEZONE).date;
    if (!selected.includes(date)) continue;
    const list = byDate.get(date) ?? [];
    list.push(row);
    byDate.set(date, list);
  }

  const batches: ReconcileBatch[] = [];
  for (const date of selected) {
    const { from, to } = shanghaiDayBounds(date);
    const dayEvents = byDate.get(date) ?? [];
    const payloads: IngestEventPayload[] = dayEvents.map((row) => ({
      event_id: row.event_id,
      occurred_at: row.occurred_at,
      integration: row.integration,
      collector: row.collector,
      model: row.model,
      usage: { ...row.usage },
      conversations_count: row.conversations_count,
      ...(row.reported_cost_usd != null
        ? { reported_cost_usd: row.reported_cost_usd }
        : {}),
    }));

    if (payloads.length === 0) {
      batches.push({
        device_id: args.deviceId,
        mode: 'replace_window',
        from,
        to,
        schema_version: 1,
        client_version: CLIENT_VERSION,
        events: [],
      });
      continue;
    }

    if (payloads.length > MAX_EVENTS_PER_RECONCILE) {
      throw new Error(
        `${date} 本地事件数 ${payloads.length} 超过单次校准上限 ${MAX_EVENTS_PER_RECONCILE}，请缩小选择范围`,
      );
    }

    batches.push({
      device_id: args.deviceId,
      mode: 'replace_window',
      from,
      to,
      schema_version: 1,
      client_version: CLIENT_VERSION,
      events: payloads,
    });
  }
  return batches;
}

export async function postReconcileBatch(
  apiUrl: string,
  token: string,
  batch: ReconcileBatch,
): Promise<ReconcileBatchResult> {
  const res = await fetch(
    `${normalizeApiUrl(apiUrl)}/v1/model-usage/reconcile`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(batch),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `reconcile failed: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`,
    );
  }
  const body = (await res.json()) as {
    success?: boolean;
    data?: ReconcileBatchResult;
    message?: string;
  };
  if (!body.success || !body.data) {
    throw new Error(body.message || 'reconcile failed');
  }
  return body.data;
}

export async function applyCalibrateSelectedDates(
  dataDir: string,
  config: TudConfig,
  selectedDates: ReadonlyArray<string>,
): Promise<{
  batches: number;
  deleted: number;
  upserted: number;
  floored: number;
}> {
  if (selectedDates.length === 0) {
    throw new Error('请先选择要对齐的日期');
  }
  const target = calibrateTarget(config);
  if (!target) {
    throw new Error('云端同步未关联或缺少 apiUrl / token / deviceId');
  }
  const sinceIso =
    maxIso(config.statsSince, productWindowSinceIso()) ??
    productWindowSinceIso();
  const localRows = await loadLocalCalibrateEvents(
    dataDir,
    config,
    target.deviceId,
    sinceIso,
  );
  const batches = buildReconcileBatches({
    deviceId: target.deviceId,
    selectedDates,
    localRows,
  });

  let deleted = 0;
  let upserted = 0;
  let floored = 0;
  for (const batch of batches) {
    const result = await postReconcileBatch(
      target.apiUrl,
      target.token,
      batch,
    );
    deleted += result.deleted_count;
    upserted += result.upserted_count;
    floored += result.floored_count;
  }

  const selectedSet = new Set(selectedDates);
  const buckets = aggregateForIngest(
    await loadBucketsForRange(dataDir, sinceIso),
  ).filter((bucket) => {
    const date = localDateAndHour(bucket.hour_start, DEFAULT_STATS_TIMEZONE)
      .date;
    return selectedSet.has(date);
  });
  const file = await loadUploadStateFile(dataDir);
  const slot = getUploadSlot(file, target.apiUrl, target.deviceId);
  const nextSlot = commitBucketHashes(slot, buckets);
  nextSlot.needsFullScan = false;
  await saveUploadStateFile(
    dataDir,
    setUploadSlot(file, target.apiUrl, target.deviceId, nextSlot),
  );

  return { batches: batches.length, deleted, upserted, floored };
}

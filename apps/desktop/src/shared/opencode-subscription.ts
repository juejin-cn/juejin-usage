import { canonicalSubscriptionPlanLabel } from './subscription-plan';

/** Read-only subset of the local OpenCode Go subscription snapshot. */
export type OpenCodeSubscriptionStatus =
  | 'ready'
  | 'unsupported-plan'
  | 'not-installed'
  | 'not-signed-in'
  | 'custom-provider'
  | 'expired'
  | 'temporarily-unavailable';

export interface OpenCodeRateLimitWindow {
  id: 'five-hour' | 'weekly';
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface OpenCodeSubscriptionSnapshot {
  status: OpenCodeSubscriptionStatus;
  planLabel: string | null;
  limits: OpenCodeRateLimitWindow[];
  /** Unix timestamp in seconds. */
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedPercent(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const normalized = number <= 1 ? number * 100 : number;
  return Math.round(Math.min(100, Math.max(0, normalized)) * 100) / 100;
}

function resetAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 10_000_000_000 ? value / 1_000 : value);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1_000) : null;
}

export function openCodePlanLabel(value: unknown): string | null {
  return canonicalSubscriptionPlanLabel(value);
}

function pickWindow(raw: Record<string, unknown>, minutes: number | null): OpenCodeRateLimitWindow | null {
  const usedPercent = boundedPercent(raw.usedPercent ?? raw.usagePercent ?? raw.percent);
  if (usedPercent === null) return null;
  const resetsAt = resetAt(raw.resetsAt ?? raw.nextResetTime ?? raw.resetTime);
  if (minutes !== null) {
    if (minutes >= 240 && minutes <= 360) {
      return { id: 'five-hour', label: '5h', usedPercent, resetsAt };
    }
    if (minutes >= 10_000 && minutes <= 10_200) {
      return { id: 'weekly', label: '7d', usedPercent, resetsAt };
    }
  }
  return null;
}

/** Normalize OpenCode Go's `GET /zen/go/v1/usage` response into tray-shaped windows. */
export function mapOpenCodeUsage(value: unknown): Pick<
  OpenCodeSubscriptionSnapshot,
  'planLabel' | 'limits'
> {
  const root = asRecord(value);
  if (!root) return { planLabel: null, limits: [] };

  const planLabel = openCodePlanLabel(root.plan ?? root.tier ?? root.planName ?? root.plan_name);

  const buckets: unknown[] = [];
  if (Array.isArray(root.windows)) buckets.push(...root.windows);
  if (Array.isArray(root.limits)) buckets.push(...root.limits);
  if (Array.isArray(root.usagePeriods)) buckets.push(...root.usagePeriods);
  const primary = asRecord(root.primary ?? root.fiveHour);
  const secondary = asRecord(root.secondary ?? root.weekly);
  if (primary) buckets.push(primary);
  if (secondary) buckets.push(secondary);

  let fiveHour: OpenCodeRateLimitWindow | null = null;
  let weekly: OpenCodeRateLimitWindow | null = null;

  for (const item of buckets) {
    const record = asRecord(item);
    if (!record) continue;
    const minutes = Number(record.windowDurationMins ?? record.windowMins ?? record.minutes);
    const window = pickWindow(
      record,
      Number.isFinite(minutes) ? minutes : null,
    );
    if (!window) continue;
    if (window.id === 'five-hour' && !fiveHour) fiveHour = window;
    if (window.id === 'weekly' && !weekly) weekly = window;
  }

  const limits: OpenCodeRateLimitWindow[] = [];
  if (fiveHour) limits.push(fiveHour);
  if (weekly) limits.push(weekly);
  return { planLabel, limits };
}

export function openCodeRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

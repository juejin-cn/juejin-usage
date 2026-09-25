import { canonicalSubscriptionPlanLabel } from './subscription-plan';

/** Read-only subset of the local MiniMax Code account and rate-limit snapshot. */
export type MiniMaxSubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'unsupported-account'
  | 'expired'
  | 'temporarily-unavailable';

export interface MiniMaxRateLimitWindow {
  id: 'five-hour' | 'weekly';
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface MiniMaxSubscriptionSnapshot {
  status: MiniMaxSubscriptionStatus;
  planLabel: string | null;
  /** 'global' | 'mainland' | null — which official region the snapshot belongs to. */
  region: 'global' | 'mainland' | null;
  limits: MiniMaxRateLimitWindow[];
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
  // The account API reports percentages as strings like "4%"; those are
  // already 0..100 and must not go through the fraction heuristic below.
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = Number(value.trim().slice(0, -1));
    return Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100 : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // Proto3 omits scalar zeros. Accept either 0..1 fractions or 0..100 percentages.
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

export function miniMaxPlanLabel(value: unknown): string | null {
  return canonicalSubscriptionPlanLabel(value);
}

interface RawMiniMaxWindow {
  type?: unknown;
  windowDurationMins?: unknown;
  usedPercent?: unknown;
  resetsAt?: unknown;
  nextResetTime?: unknown;
}

function pickWindow(raw: RawMiniMaxWindow | null): MiniMaxRateLimitWindow | null {
  if (!raw) return null;
  const usedPercent = boundedPercent(raw.usedPercent);
  if (usedPercent === null) return null;
  const minutes = Number(raw.windowDurationMins);
  const resetsAt = resetAt(raw.resetsAt ?? raw.nextResetTime);
  // The Coding Plan endpoint discriminates windows by duration; bucket the
  // 5-hour rolling window separately from the weekly pool so the tray card
  // can render two concentric rings.
  if (Number.isFinite(minutes)) {
    if (minutes >= 240 && minutes <= 360) {
      return { id: 'five-hour', label: '5h', usedPercent, resetsAt };
    }
    if (minutes >= 10_000 && minutes <= 10_200) {
      return { id: 'weekly', label: '7d', usedPercent, resetsAt };
    }
  }
  return null;
}

/** Normalize MiniMax Code's Coding Plan `token_plan/remains` response. */
export function mapMiniMaxQuota(value: unknown): Pick<
  MiniMaxSubscriptionSnapshot,
  'planLabel' | 'limits'
> {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? root;
  if (!data) return { planLabel: null, limits: [] };

  const planLabel = miniMaxPlanLabel(
    data.plan ?? data.planType ?? data.level ?? data.plan_name ?? data.planName,
  );

  let fiveHour: MiniMaxRateLimitWindow | null = null;
  let weekly: MiniMaxRateLimitWindow | null = null;

  const buckets: unknown[] = [];
  if (Array.isArray(data.windows)) buckets.push(...data.windows);
  if (Array.isArray(data.rateLimits)) buckets.push(...data.rateLimits);
  if (Array.isArray(data.limits)) buckets.push(...data.limits);
  const primary = asRecord(data.primary ?? data.fiveHour);
  const secondary = asRecord(data.secondary ?? data.weekly);
  if (primary) buckets.push(primary);
  if (secondary) buckets.push(secondary);

  for (const item of buckets) {
    const window = pickWindow(asRecord(item) as RawMiniMaxWindow | null);
    if (!window) continue;
    if (window.id === 'five-hour' && !fiveHour) fiveHour = window;
    if (window.id === 'weekly' && !weekly) weekly = window;
  }

  const limits: MiniMaxRateLimitWindow[] = [];
  if (fiveHour) limits.push(fiveHour);
  if (weekly) limits.push(weekly);
  return { planLabel, limits };
}

export function miniMaxRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/** Account-API auth failures arrive as HTTP 200 with `base_resp.status_code`. */
export function miniMaxResponseAuthFailed(value: unknown): boolean {
  const base = asRecord(asRecord(value)?.base_resp);
  const code = Number(base?.status_code);
  return code === 401 || code === 403 || code === 1002 || code === 1004;
}

interface RawMavisRemainsEntry {
  model_name?: unknown;
  end_time?: unknown;
  weekly_end_time?: unknown;
  current_interval_used_percent?: unknown;
  current_interval_status?: unknown;
  current_weekly_used_percent?: unknown;
}

/**
 * Normalize the mcode account API pair: `commerce/get_membership_info` for the
 * Token Plan tier and `token_plan/remains_percent` for the 5h/weekly windows.
 */
export function mapMiniMaxAccountQuota(
  membership: unknown,
  remains: unknown,
): Pick<MiniMaxSubscriptionSnapshot, 'planLabel' | 'limits'> {
  const member = asRecord(membership);
  const planLabel = miniMaxPlanLabel(member?.token_plan_tier ?? member?.plan_name);

  const root = asRecord(remains);
  const entries = Array.isArray(root?.model_remains) ? root.model_remains : [];
  const general = entries.find((item) => asRecord(item)?.model_name === 'general');
  const entry = asRecord(general ?? entries[0]) as RawMavisRemainsEntry | null;
  if (!entry) return { planLabel, limits: [] };

  const limits: MiniMaxRateLimitWindow[] = [];
  // status 3 marks an unlimited interval; render it as a fresh window.
  const unlimitedFiveHour = Number(entry.current_interval_status) === 3;
  const fiveHour = unlimitedFiveHour
    ? 0
    : boundedPercent(entry.current_interval_used_percent);
  if (fiveHour !== null) {
    limits.push({ id: 'five-hour', label: '5h', usedPercent: fiveHour, resetsAt: resetAt(entry.end_time) });
  }
  const weekly = boundedPercent(entry.current_weekly_used_percent);
  if (weekly !== null) {
    limits.push({ id: 'weekly', label: '7d', usedPercent: weekly, resetsAt: resetAt(entry.weekly_end_time) });
  }
  return { planLabel, limits };
}

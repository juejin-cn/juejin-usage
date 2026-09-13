export type AntigravitySubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'temporarily-unavailable';

export interface AntigravityRateLimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface AntigravitySubscriptionSnapshot {
  status: AntigravitySubscriptionStatus;
  planLabel: string | null;
  limits: AntigravityRateLimitWindow[];
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function percent(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number <= 1 ? number * 100 : number));
}

function resetAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
}

/** Maps Antigravity's official model quota payload, keeping only two useful pools. */
export function mapAntigravityModels(value: unknown): AntigravityRateLimitWindow[] {
  const root = asRecord(value);
  const models = asRecord(root?.models) ?? asRecord(asRecord(root?.data)?.models);
  if (!models) return [];

  const limits: AntigravityRateLimitWindow[] = [];
  for (const [id, item] of Object.entries(models)) {
    const model = asRecord(item);
    const quota = asRecord(model?.quotaInfo) ?? asRecord(model?.quota);
    const remaining = percent(quota?.remainingFraction ?? quota?.remainingPercentage);
    if (!quota || remaining === null) continue;
    const label = String(model?.displayName ?? model?.label ?? model?.model ?? id).trim();
    if (!label) continue;
    limits.push({
      id,
      label,
      usedPercent: 100 - remaining,
      resetsAt: resetAt(quota.resetTime),
    });
  }

  return limits
    .sort((left, right) => left.usedPercent - right.usedPercent)
    .slice(0, 2);
}

export function antigravityRemainingPercent(usedPercent: number): number {
  return Number.isFinite(usedPercent) ? Math.min(100, Math.max(0, 100 - usedPercent)) : 0;
}

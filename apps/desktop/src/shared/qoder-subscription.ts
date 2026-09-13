export type QoderSubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'temporarily-unavailable';

export interface QoderRateLimitWindow {
  id: 'plan' | 'add-on';
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface QoderSubscriptionSnapshot {
  status: QoderSubscriptionStatus;
  planLabel: string | null;
  limits: QoderRateLimitWindow[];
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function usedPercent(value: unknown): number | null {
  const row = asRecord(value);
  const percentage = Number(row?.percentage ?? row?.used_percentage ?? row?.usedPercentage);
  if (Number.isFinite(percentage)) {
    const normalized = percentage >= 0 && percentage <= 1 ? percentage * 100 : percentage;
    return Math.min(100, Math.max(0, normalized));
  }
  const total = Number(row?.total);
  const used = Number(row?.used);
  return Number.isFinite(total) && total > 0 && Number.isFinite(used)
    ? Math.min(100, Math.max(0, used / total * 100))
    : null;
}

function timestamp(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.floor(number > 10_000_000_000 ? number / 1_000 : number)
    : null;
}

function planLabel(value: unknown): string | null {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? root;
  const label = data?.plan_tier_name ?? data?.planTierName ?? data?.plan_name ?? data?.planName;
  return typeof label === 'string' && label.trim() ? label.trim() : null;
}

/** Normalizes Qoder's official account quota endpoint; organization credits stay out of the tray. */
export function mapQoderQuota(value: unknown, plan: unknown): Pick<QoderSubscriptionSnapshot, 'planLabel' | 'limits'> {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? root;
  if (!data) return { planLabel: planLabel(plan), limits: [] };
  const resetsAt = timestamp(data.expires_at ?? data.expiresAt);
  const rows: Array<[QoderRateLimitWindow['id'], string, unknown]> = [
    ['plan', '套餐', data.user_quota ?? data.userQuota],
    ['add-on', '加购', data.add_on_quota ?? data.addOnQuota],
  ];
  const limits = rows.flatMap(([id, label, quota]) => {
    const usage = usedPercent(quota);
    return usage === null ? [] : [{ id, label, usedPercent: usage, resetsAt }];
  });
  return { planLabel: planLabel(plan), limits };
}

export function qoderRemainingPercent(usedPercent: number): number {
  return Number.isFinite(usedPercent) ? Math.min(100, Math.max(0, 100 - usedPercent)) : 0;
}

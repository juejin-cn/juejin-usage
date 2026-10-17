import { nonNegativeNumber, subscriptionAmounts, type SubscriptionAmounts } from './subscription-amounts.js';
import { canonicalSubscriptionPlanLabel } from './subscription-plan.js';

export type QoderSubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'temporarily-unavailable';

export interface QoderRateLimitWindow {
  id: 'plan' | 'add-on' | 'shared' | `dedicated-${number}`;
  amounts?: SubscriptionAmounts;
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
  const total = nonNegativeNumber(row?.total ?? row?.cap);
  const remaining = nonNegativeNumber(row?.remaining);
  const used = nonNegativeNumber(row?.used) ?? (total !== null && remaining !== null && remaining <= total ? total - remaining : null);
  if (total === 0) return 0;
  if (total !== null && used !== null) return Math.min(100, Math.max(0, used / total * 100));
  const percentage = nonNegativeNumber(row?.percentage ?? row?.used_percentage ?? row?.usedPercentage);
  if (percentage !== null) {
    const normalized = percentage >= 0 && percentage <= 1 ? percentage * 100 : percentage;
    return Math.min(100, Math.max(0, normalized));
  }
  return null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  let milliseconds: number;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    milliseconds = Date.parse(value);
  } else {
    const number = Number(value);
    // Qoder uses year 9999 for no expiry. Check seconds before inferring units.
    if (number >= Date.UTC(9999, 0, 1) / 1000 && number < Date.UTC(10000, 0, 1) / 1000) return null;
    milliseconds = number > 10_000_000_000 ? number : number * 1000;
  }
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < Date.UTC(9999, 0, 1)
    ? Math.floor(milliseconds / 1000)
    : null;
}

function planLabel(value: unknown): string | null {
  const root = asRecord(value);
  const payload = asRecord(root?.data) ?? root;
  const data = asRecord(payload?.qoderUsage) ?? payload;
  const label = data?.plan_tier_name ?? data?.planTierName ?? data?.plan_name ?? data?.planName;
  if (typeof label === 'string' && label.trim()) return canonicalSubscriptionPlanLabel(label);

  // Qoder CLI's cached quota response does not include the `/user/plan`
  // payload, but it does retain the account's membership type. This is the
  // only plan signal available when the local auth state is encrypted.
  const membershipType = data?.user_type ?? data?.userType;
  return canonicalSubscriptionPlanLabel(membershipType);
}

/** Normalizes Qoder's official account quota endpoint, retaining each reported pool. */
export function mapQoderQuota(value: unknown, plan: unknown): Pick<QoderSubscriptionSnapshot, 'planLabel' | 'limits'> {
  const root = asRecord(value);
  const payload = asRecord(root?.data) ?? root;
  const data = asRecord(payload?.qoderUsage) ?? payload;
  if (!data) return { planLabel: planLabel(plan), limits: [] };
  const resetsAt = timestamp(data.expires_at ?? data.expiresAt);
  const rows: Array<[QoderRateLimitWindow['id'], string, unknown]> = [
    ['plan', 'Credits', data.user_quota ?? data.userQuota],
    ['add-on', 'Add-on Credits', data.add_on_quota ?? data.addOnQuota],
    ['shared', 'Shared Credits', data.org_resource_package ?? data.orgResourcePackage],
  ];
  const dedicated = data.dedicated_resource_packages ?? data.dedicatedResourcePackages;
  if (Array.isArray(dedicated)) dedicated.forEach((item, index) => rows.push([`dedicated-${index}`, 'Dedicated Credits', item]));
  const limits = rows.flatMap(([id, label, quota]) => {
    const usage = usedPercent(quota);
    const row = asRecord(quota);
    const amounts = subscriptionAmounts(row?.total ?? row?.cap, row?.used, row?.remaining, typeof row?.unit === 'string' ? row.unit : 'Credits');
    return usage === null ? [] : [{ id, label: typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : label, usedPercent: usage, resetsAt, ...(amounts ? { amounts } : {}) }];
  });
  // Prefer the dedicated plan endpoint, then fall back to the quota response
  // persisted by the official CLI.
  return { planLabel: planLabel(plan) ?? planLabel(value), limits };
}

export function qoderRemainingPercent(usedPercent: number): number {
  return Number.isFinite(usedPercent) ? Math.min(100, Math.max(0, 100 - usedPercent)) : 0;
}

/** Keeps confirmed Qoder accounts visible when their current quota lookup fails. */
export function qoderSubscriptionHasAccount(snapshot: QoderSubscriptionSnapshot): boolean {
  return snapshot.status !== 'not-installed' && snapshot.status !== 'not-signed-in';
}

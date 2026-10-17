import { subscriptionAmounts, type SubscriptionAmounts } from './subscription-amounts.js';
import { canonicalSubscriptionPlanLabel } from './subscription-plan.js';

export type CopilotSubscriptionStatus =
  | 'ready'
  | 'not-installed'
  | 'not-signed-in'
  | 'temporarily-unavailable';

export interface CopilotRateLimitWindow {
  amounts?: SubscriptionAmounts;
  id: 'chat' | 'completions' | 'premium_interactions';
  label: string;
  remainingPercent: number | null;
  unlimited: boolean;
  /** An organization can exhaust a pooled quota with no individual limit. */
  exhausted?: boolean;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface CopilotSubscriptionSnapshot {
  status: CopilotSubscriptionStatus;
  planLabel: string | null;
  limits: CopilotRateLimitWindow[];
  /** Unix timestamp in seconds. */
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedPercent(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Number.isFinite(new Date(value * 1_000).getTime()) ? Math.floor(value) : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis > 0 ? Math.floor(millis / 1_000) : null;
}

function readPlanLabel(root: Record<string, unknown>): string | null {
  // Free and Student may also report copilot_plan: 'individual'.
  if (root.access_type_sku === 'free_limited_copilot') return 'Free';
  if (root.access_type_sku === 'free_educational_quota') return 'Student';
  const plans: Record<string, string> = {
    individual: 'Pro',
    individual_edu: 'Student',
    individual_pro: 'Pro+',
    individual_max: 'Max',
    business: 'Business',
    enterprise: 'Enterprise',
  };
  const plan = typeof root.copilot_plan === 'string' ? root.copilot_plan.trim() : '';
  return Object.hasOwn(plans, plan) ? plans[plan] : canonicalSubscriptionPlanLabel(plan);
}

function readSnapshot(
  snapshot: Record<string, unknown>,
  id: CopilotRateLimitWindow['id'],
  label: string,
  accountReset: number | null,
): CopilotRateLimitWindow | null {
  const entitlement = finiteNumber(snapshot.entitlement);
  const unlimited = snapshot.unlimited === true || entitlement === -1;
  // Zero entitlement means this category is not allocated, not that it ran out.
  if (!unlimited && entitlement === 0) return null;
  const remaining = finiteNumber(snapshot.quota_remaining) ?? finiteNumber(snapshot.remaining);
  const remainingPercent = boundedPercent(snapshot.percent_remaining) ?? (
    entitlement !== null && entitlement > 0 && remaining !== null && remaining >= 0
      ? boundedPercent(remaining / entitlement * 100)
      : null
  );
  if (!unlimited && remainingPercent === null && !(entitlement !== null && entitlement > 0)) return null;
  const amounts = unlimited ? undefined : subscriptionAmounts(entitlement, undefined, remaining);
  return {
    id,
    label,
    remainingPercent: unlimited ? null : remainingPercent,
    unlimited,
    ...(amounts ? { amounts } : {}),
    ...(unlimited && snapshot.has_quota === false ? { exhausted: true } : {}),
    resetsAt: parseTimestamp(snapshot.quota_reset_at) ?? accountReset,
  };
}

/** Normalize the same internal entitlement response used by VS Code's Copilot dashboard. */
export function mapCopilotSubscription(value: unknown): Pick<
  CopilotSubscriptionSnapshot,
  'planLabel' | 'limits'
> {
  const root = asRecord(value);
  if (!root) return { planLabel: null, limits: [] };
  const planLabel = readPlanLabel(root);
  const usageBasedBilling = root.token_based_billing === true;
  const snapshots = asRecord(root.quota_snapshots);
  const monthly = asRecord(root.monthly_quotas);
  const remaining = asRecord(root.limited_user_quotas);
  const accountReset = parseTimestamp(root.quota_reset_date_utc)
    ?? parseTimestamp(root.quota_reset_date)
    ?? parseTimestamp(root.limited_user_reset_date);
  const limits: CopilotRateLimitWindow[] = [];

  // Paid usage-based plans use premium_interactions; Free keeps chat and completions.
  for (const id of ['chat', 'premium_interactions', 'completions'] as const) {
    if (id !== 'premium_interactions' && usageBasedBilling && planLabel !== 'Free') continue;
    const label = id === 'completions' ? 'Inline Suggestions'
      : usageBasedBilling ? 'Credits'
        : id === 'chat' ? 'Chat messages' : 'Premium requests';
    const snapshot = asRecord(snapshots?.[id]);
    let limit = snapshot ? readSnapshot(snapshot, id, label, accountReset) : null;
    if (!snapshot && id !== 'premium_interactions') {
      const total = finiteNumber(monthly?.[id]);
      const left = finiteNumber(remaining?.[id]);
      if (total !== null && total > 0 && left !== null && left >= 0) {
        limit = {
          id,
          label,
          remainingPercent: boundedPercent(left / total * 100),
          unlimited: false,
          amounts: subscriptionAmounts(total, undefined, left),
          resetsAt: accountReset,
        };
      }
    }
    // Like VS Code, omit unlimited base features and keep an unlimited premium quota.
    if (limit && (id === 'premium_interactions' || !limit.unlimited)) limits.push(limit);
  }

  return { planLabel, limits };
}

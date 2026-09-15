import { canonicalSubscriptionPlanLabel } from './subscription-plan';

/** Read-only subset of the local TRAE IDE account entitlement snapshot. */
export type TraeSubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'temporarily-unavailable';

export type TraeRegion = 'global' | 'mainland';

export type TraeEntitlementKind = 'basic' | 'bonus' | 'extra';

export interface TraeEntitlementWindow {
  id: TraeEntitlementKind;
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface TraeSubscriptionSnapshot {
  status: TraeSubscriptionStatus;
  planLabel: string | null;
  region: TraeRegion;
  limits: TraeEntitlementWindow[];
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

const KIND_LABELS: Record<TraeEntitlementKind, string> = {
  basic: 'Basic',
  bonus: 'Bonus',
  extra: 'Extra',
};

function pickEntitlement(
  raw: Record<string, unknown>,
  kind: TraeEntitlementKind,
): TraeEntitlementWindow | null {
  const usedPercent = boundedPercent(
    raw.usedPercent
      ?? raw.usagePercent
      ?? raw.percent
      ?? raw.percentage
      ?? raw.used_percentage,
  );
  if (usedPercent === null) return null;
  return {
    id: kind,
    label: KIND_LABELS[kind],
    usedPercent,
    resetsAt: resetAt(raw.resetsAt ?? raw.nextResetTime ?? raw.expireAt ?? raw.resetTime),
  };
}

/**
 * Normalize TRAE's entitlement payload without assuming a fixed schema.
 *
 * The entitlement endpoint is not a public compatibility contract, so the
 * mapper accepts several reasonable shapes (`packs[]`, `entitlements[]`,
 * or `data.packs[]`) and quietly falls back when nothing matches. The
 * adapter treats any non-empty mapped list as `ready`; otherwise the
 * caller surfaces a stale/temporarily-unavailable snapshot.
 */
export function mapTraeEntitlements(value: unknown): Pick<
  TraeSubscriptionSnapshot,
  'planLabel' | 'limits'
> {
  const root = asRecord(value);
  if (!root) return { planLabel: null, limits: [] };
  const data = asRecord(root.data) ?? root;
  const planLabel = canonicalSubscriptionPlanLabel(
    data.plan ?? data.tier ?? data.subscriptionType,
  );

  const candidates: unknown[] = [];
  if (Array.isArray(data.packs)) candidates.push(...data.packs);
  if (Array.isArray(data.entitlements)) candidates.push(...data.entitlements);
  if (Array.isArray(data.bundles)) candidates.push(...data.bundles);
  if (Array.isArray(root.packs)) candidates.push(...root.packs);

  const limits: TraeEntitlementWindow[] = [];
  for (const item of candidates) {
    const record = asRecord(item);
    if (!record) continue;
    const type = String(record.type ?? record.kind ?? record.name ?? '').toLowerCase();
    let kind: TraeEntitlementKind | null = null;
    if (type.includes('basic')) kind = 'basic';
    else if (type.includes('bonus')) kind = 'bonus';
    else if (type.includes('extra')) kind = 'extra';
    if (!kind) continue;
    const window = pickEntitlement(record, kind);
    if (window && !limits.find((existing) => existing.id === window.id)) {
      limits.push(window);
    }
  }

  return { planLabel, limits };
}

export function traeRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

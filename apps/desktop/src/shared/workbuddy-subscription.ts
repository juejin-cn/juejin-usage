import { canonicalSubscriptionPlanLabel } from './subscription-plan';

/** Read-only subset of the local WorkBuddy account resource snapshot. */
export type WorkBuddySubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'temporarily-unavailable';

export type WorkBuddyRegion = 'global' | 'mainland';

export interface WorkBuddyResourceWindow {
  id: string;
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface WorkBuddySubscriptionSnapshot {
  status: WorkBuddySubscriptionStatus;
  planLabel: string | null;
  region: WorkBuddyRegion;
  limits: WorkBuddyResourceWindow[];
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

/** Read-only mapper for WorkBuddy account-resource payloads. */
export function mapWorkBuddyResources(value: unknown): Pick<
  WorkBuddySubscriptionSnapshot,
  'planLabel' | 'limits'
> {
  const root = asRecord(value);
  if (!root) return { planLabel: null, limits: [] };
  const data = asRecord(root.data) ?? root;
  const planLabel = canonicalSubscriptionPlanLabel(data.plan ?? data.tier);

  const candidates: unknown[] = [];
  if (Array.isArray(data.resources)) candidates.push(...data.resources);
  if (Array.isArray(data.packages)) candidates.push(...data.packages);
  if (Array.isArray(data.bundles)) candidates.push(...data.bundles);
  if (Array.isArray(root.resources)) candidates.push(...root.resources);

  const limits: WorkBuddyResourceWindow[] = [];
  const seenIds = new Set<string>();
  for (const item of candidates) {
    const record = asRecord(item);
    if (!record) continue;
    const usedPercent = boundedPercent(
      record.usedPercent
        ?? record.usagePercent
        ?? record.percent
        ?? record.percentage
        ?? (() => {
          const used = Number(record.used);
          const total = Number(record.total ?? record.limit);
          if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
            return Math.min(100, Math.max(0, (used / total) * 100));
          }
          return null;
        })(),
    );
    if (usedPercent === null) continue;
    const id = String(record.id ?? record.unit ?? record.name ?? 'default').trim() || 'default';
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const label = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : typeof record.unit === 'string' && record.unit.trim()
        ? record.unit.trim()
        : id;
    limits.push({
      id,
      label,
      usedPercent,
      resetsAt: resetAt(record.expireAt ?? record.expiresAt ?? record.resetTime ?? record.nextResetTime),
    });
  }

  return { planLabel, limits };
}

export function workBuddyRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

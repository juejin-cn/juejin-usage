export type KimiSubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'temporarily-unavailable';

export interface KimiRateLimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface KimiSubscriptionSnapshot {
  status: KimiSubscriptionStatus;
  planLabel: string | null;
  limits: KimiRateLimitWindow[];
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

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function resetAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : null;
}

function windowLabel(window: Record<string, unknown> | null, fallback: string): string {
  if (!window) return fallback;
  const duration = finiteNumber(window.duration);
  const unit = String(window.timeUnit ?? window.unit ?? '').toLowerCase();
  if (duration === null || duration <= 0) return fallback;
  if (unit.includes('minute')) return duration >= 60 && duration % 60 === 0
    ? `${duration / 60}h`
    : `${duration}m`;
  if (unit.includes('hour')) return `${duration}h`;
  if (unit.includes('day')) return `${duration}d`;
  if (unit.includes('week')) return `${duration * 7}d`;
  return fallback;
}

function toWindow(
  value: unknown,
  fallback: string,
  window: Record<string, unknown> | null = null,
): KimiRateLimitWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const used = finiteNumber(record.used);
  const limit = finiteNumber(record.limit);
  if (used === null || limit === null || limit <= 0) return null;
  const label = typeof record.name === 'string' && record.name.trim()
    ? record.name.trim()
    : windowLabel(window, fallback);
  return {
    id: label.toLowerCase().replace(/\s+/g, '-'),
    label,
    usedPercent: boundedPercent(used / limit * 100),
    resetsAt: resetAt(record.resetTime ?? record.reset_at ?? record.resetAt),
  };
}

/** Normalize Kimi Code's official `/usages` response into tray-sized windows. */
export function mapKimiUsage(value: unknown): KimiRateLimitWindow[] {
  const root = asRecord(value);
  if (!root) return [];
  const payload = asRecord(root.data) ?? root;
  const limits: KimiRateLimitWindow[] = [];
  const summary = toWindow(payload.usage, '7d', { duration: 1, unit: 'week' });
  if (summary) limits.push({ ...summary, id: 'weekly', label: '7d' });

  if (Array.isArray(payload.limits)) {
    for (const item of payload.limits) {
      const record = asRecord(item);
      if (!record) continue;
      const row = toWindow(record.detail ?? record, '额度', asRecord(record.window));
      if (row) limits.push(row);
    }
  }

  const byLabel = new Map<string, KimiRateLimitWindow>();
  for (const item of limits) {
    const canonical = item.label.toLowerCase();
    if (!byLabel.has(canonical)) byLabel.set(canonical, item);
  }
  return [...byLabel.values()]
    .sort((left, right) => {
      const rank = (label: string) => label === '5h' ? 0 : label === '7d' ? 1 : 2;
      return rank(left.label) - rank(right.label);
    })
    .slice(0, 2);
}

export function kimiRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

export type ZcodeSubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'temporarily-unavailable';

export interface ZcodeRateLimitWindow {
  id: 'five-hour' | 'weekly' | 'mcp';
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface ZcodeSubscriptionSnapshot {
  status: ZcodeSubscriptionStatus;
  planLabel: string | null;
  limits: ZcodeRateLimitWindow[];
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
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

function resetAt(value: unknown): number | null {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.floor((timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000) / 1_000);
}

export function zcodePlanLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized.includes('max')) return 'Max';
  if (normalized.includes('pro')) return 'Pro';
  if (normalized.includes('lite')) return 'Lite';
  if (normalized.includes('start')) return 'Start Plan';
  return value.trim();
}

/** Normalize Z.ai / BigModel Coding Plan quota responses without retaining credentials. */
export function mapZcodeQuota(value: unknown): Pick<ZcodeSubscriptionSnapshot, 'planLabel' | 'limits'> {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? root;
  if (!data || !Array.isArray(data.limits)) return { planLabel: zcodePlanLabel(data?.level), limits: [] };

  const limits: ZcodeRateLimitWindow[] = [];
  for (const item of data.limits) {
    const record = asRecord(item);
    if (!record) continue;
    const usedPercent = boundedPercent(record.percentage);
    if (usedPercent === null) continue;
    const type = String(record.type ?? '').toUpperCase();
    const unit = Number(record.unit);
    if ((type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') && unit === 3) {
      limits.push({ id: 'five-hour', label: '5h', usedPercent, resetsAt: resetAt(record.nextResetTime) });
    } else if ((type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') && unit === 6) {
      limits.push({ id: 'weekly', label: '7d', usedPercent, resetsAt: resetAt(record.nextResetTime) });
    } else if (type === 'TIME_LIMIT') {
      limits.push({ id: 'mcp', label: 'MCP', usedPercent, resetsAt: resetAt(record.nextResetTime) });
    }
  }

  const priority: Record<ZcodeRateLimitWindow['id'], number> = { 'five-hour': 0, weekly: 1, mcp: 2 };
  return {
    planLabel: zcodePlanLabel(data.level),
    limits: limits
      .sort((left, right) => priority[left.id] - priority[right.id])
      .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index),
  };
}

export function zcodeRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

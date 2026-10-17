import { nonNegativeNumber } from './subscription-amounts.js';
import { canonicalSubscriptionPlanLabel } from './subscription-plan.js';

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

/** Which side of the ZCode account the snapshot belongs to. */
export type ZcodeAccountProvider = 'zai' | 'bigmodel';

export interface ZcodeSubscriptionSnapshot {
  resetCredits?: {
    fiveHour: { expiresAt: number }[];
    weekly: { expiresAt: number }[];
  };
  status: ZcodeSubscriptionStatus;
  planLabel: string | null;
  /** 'zai' (global) | 'bigmodel' (mainland) | null before credentials resolve. */
  provider: ZcodeAccountProvider | null;
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
  const number = nonNegativeNumber(value);
  return number !== null ? Math.min(100, Math.max(0, number)) : null;
}

/** BigModel reports auth failures as HTTP 200 with a body-level `code`. */
export function zcodeResponseAuthFailed(value: unknown): boolean {
  const code = Number(asRecord(value)?.code);
  return code === 401 || code === 403;
}

function resetAt(value: unknown): number | null {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.floor((timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000) / 1_000);
}

export function zcodePlanLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized.includes('max')) return canonicalSubscriptionPlanLabel('max');
  if (normalized.includes('pro')) return canonicalSubscriptionPlanLabel('pro');
  if (normalized.includes('lite')) return 'Lite';
  if (normalized.includes('start')) return 'Start Plan';
  return canonicalSubscriptionPlanLabel(value);
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
    } else if (type === 'TIME_LIMIT'
      && (record.unit === undefined || unit === 5)
      && (record.number === undefined || Number(record.number) === 1)) {
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

/** ZCode desktop getCodingPlanResetStatus response; only available cards are retained. */
export function mapZcodeResetCredits(value: unknown): ZcodeSubscriptionSnapshot['resetCredits'] {
  const root = asRecord(value);
  const data = asRecord(root?.data);
  if (root?.code !== 0 || !data || !Array.isArray(data.available_five_hour_resets) || !Array.isArray(data.available_week_resets)) return undefined;
  const parse = (items: unknown[]) => {
    const cards: { expiresAt: number }[] = [];
    for (const item of items) {
      const expiresAt = resetAt(asRecord(item)?.expire_at);
      if (expiresAt === null) return null;
      cards.push({ expiresAt });
    }
    return cards;
  };
  const fiveHour = parse(data.available_five_hour_resets);
  const weekly = parse(data.available_week_resets);
  return fiveHour && weekly ? { fiveHour, weekly } : undefined;
}

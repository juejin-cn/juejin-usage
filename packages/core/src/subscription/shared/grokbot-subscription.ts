import { mapCursorGrokBotUsage, type CursorRateLimitWindow } from './cursor-subscription.js';

export interface GrokBotSubscriptionSnapshot {
  status: 'ready' | 'not-installed' | 'not-signed-in' | 'unavailable';
  planLabel: string | null;
  weekly: CursorRateLimitWindow | null;
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
}

/** Same billing service as Cursor, but authenticated by the standalone Bot account. */
export function mapGrokBotUsage(value: unknown, now = Date.now()): Pick<GrokBotSubscriptionSnapshot, 'weekly' | 'planLabel'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { weekly: null, planLabel: null };
  const data = value as Record<string, unknown>;
  const label = typeof data.grokPlanLabel === 'string' ? data.grokPlanLabel.trim() : '';
  return {
    // An organization-wide allowance must not be presented as a personal quota.
    weekly: data.usesPooledEnterpriseAllowance === true || typeof data.usagePercent !== 'number'
      || !Number.isFinite(data.usagePercent) ? null : mapCursorGrokBotUsage(data, now),
    planLabel: label && label.length <= 100 ? label : null,
  };
}

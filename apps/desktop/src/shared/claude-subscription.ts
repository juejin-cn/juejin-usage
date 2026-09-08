/** Read-only Claude.ai subscription allowance exposed to the renderer. */
export type ClaudeSubscriptionStatus =
  | 'ready'
  | 'authorization-required'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'expired'
  | 'access-denied'
  | 'temporarily-unavailable';

export interface ClaudeRateLimitWindow {
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface ClaudeSubscriptionSnapshot {
  status: ClaudeSubscriptionStatus;
  planLabel: string | null;
  fiveHour: ClaudeRateLimitWindow | null;
  sevenDay: ClaudeRateLimitWindow | null;
  /** Unix timestamp in seconds. */
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function normalizeWindow(value: unknown): ClaudeRateLimitWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const usedPercent = Number(record.utilization);
  if (!Number.isFinite(usedPercent)) return null;
  const parsedReset = typeof record.resets_at === 'string'
    ? Date.parse(record.resets_at)
    : Number.NaN;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAt: Number.isFinite(parsedReset) ? Math.floor(parsedReset / 1_000) : null,
  };
}

/** Normalize Anthropic's OAuth usage payload without retaining extra fields. */
export function mapClaudeUsageWindows(value: unknown): Pick<
  ClaudeSubscriptionSnapshot,
  'fiveHour' | 'sevenDay'
> {
  const record = asRecord(value);
  return {
    fiveHour: normalizeWindow(record?.five_hour),
    sevenDay: normalizeWindow(record?.seven_day),
  };
}

/** Convert used allowance into the bounded remaining percentage shown in the tray. */
export function claudeRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/** Normalize credential subscription identifiers into compact tray labels. */
export function claudePlanLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const labels: Record<string, string> = {
    free: 'Free',
    pro: 'Pro',
    max: 'Max',
    max5x: 'Max 5x',
    max20x: 'Max 20x',
    team: 'Team',
    enterprise: 'Enterprise',
  };
  return labels[normalized] ?? 'Claude.ai';
}

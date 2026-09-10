/** Read-only subset of the local Codex account and rate-limit snapshot. */
export type CodexSubscriptionStatus =
  | 'ready'
  | 'unavailable'
  | 'not-installed'
  | 'not-signed-in'
  | 'unsupported-account';

export interface CodexRateLimitWindow {
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface CodexSubscriptionSnapshot {
  status: CodexSubscriptionStatus;
  planLabel: string | null;
  fiveHour: CodexRateLimitWindow | null;
  weekly: CodexRateLimitWindow | null;
  message: string | null;
}

interface RawRateLimitWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}

/** Convert Codex's plan identifiers into compact Chinese tray labels. */
export function codexPlanLabel(planType: unknown): string | null {
  const labels: Record<string, string> = {
    free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite',
    team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
    edu_plus: 'Edu Plus', edu_pro: 'Edu Pro',
  };
  return typeof planType === 'string' ? (labels[planType] ?? 'ChatGPT') : null;
}

/** Convert the app-server's used percentage into the remaining allowance. */
export function codexRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

function normalizeWindow(raw: RawRateLimitWindow): CodexRateLimitWindow | null {
  const usedPercent = Number(raw.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  const resetsAt = Number(raw.resetsAt);
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

/** Codex names windows primary/secondary; their duration is the discriminator. */
export function mapCodexRateLimitWindows(input: {
  primary?: RawRateLimitWindow | null;
  secondary?: RawRateLimitWindow | null;
}): Pick<CodexSubscriptionSnapshot, 'fiveHour' | 'weekly'> {
  let fiveHour: CodexRateLimitWindow | null = null;
  let weekly: CodexRateLimitWindow | null = null;
  for (const raw of [input.primary, input.secondary]) {
    if (!raw) continue;
    const minutes = Number(raw.windowDurationMins);
    const window = normalizeWindow(raw);
    if (!window || !Number.isFinite(minutes)) continue;
    if (minutes >= 240 && minutes <= 360) fiveHour = window;
    if (minutes >= 10_000 && minutes <= 10_200) weekly = window;
  }
  return { fiveHour, weekly };
}

export type CursorSubscriptionStatus =
  | 'ready'
  | 'not-installed'
  | 'not-signed-in'
  | 'temporarily-unavailable';

export interface CursorRateLimitWindow {
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface CursorSubscriptionSnapshot {
  status: CursorSubscriptionStatus;
  planLabel: string | null;
  cursorModels: CursorRateLimitWindow | null;
  otherModels: CursorRateLimitWindow | null;
  /** Legacy Cursor responses expose one combined plan allowance. */
  plan: CursorRateLimitWindow | null;
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

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedPercent(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 10_000_000_000 ? value / 1_000 : value);
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1_000) : null;
}

function normalizePlanLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const labels: Record<string, string> = {
    free: 'Free',
    pro: 'Pro',
    business: 'Business',
    enterprise: 'Enterprise',
    team: 'Team',
    ultra: 'Ultra',
  };
  return labels[normalized] ?? value.trim();
}

function selectUsage(root: Record<string, unknown>): Record<string, unknown> | null {
  const individual = asRecord(root.individualUsage);
  const team = asRecord(root.teamUsage);
  const individualPlan = asRecord(individual?.plan);
  const teamPlan = asRecord(team?.plan);

  if (individualPlan && Object.keys(individualPlan).length > 0) return individual;
  if (teamPlan && Object.keys(teamPlan).length > 0) return team;
  return individual ?? team;
}

/** Normalize Cursor's current dashboard response plus its older combined-plan shape. */
export function mapCursorUsageSummary(value: unknown): Pick<
  CursorSubscriptionSnapshot,
  'planLabel' | 'cursorModels' | 'otherModels' | 'plan'
> {
  const root = asRecord(value);
  if (!root) {
    return { planLabel: null, cursorModels: null, otherModels: null, plan: null };
  }
  const usage = selectUsage(root);
  const plan = asRecord(usage?.plan);
  const resetsAt = parseTimestamp(root.billingCycleEnd);
  const cursorPercent = boundedPercent(plan?.autoPercentUsed);
  const otherPercent = boundedPercent(plan?.apiPercentUsed);

  let combinedPlan: CursorRateLimitWindow | null = null;
  if (cursorPercent === null && otherPercent === null) {
    const used = finiteNumber(plan?.used);
    const breakdown = asRecord(plan?.breakdown);
    const limit = [
      finiteNumber(plan?.limit),
      finiteNumber(breakdown?.total),
      finiteNumber(plan?.total),
    ].find((candidate): candidate is number => candidate !== null && candidate > 0);
    const totalPercent = boundedPercent(plan?.totalPercentUsed);
    const usedPercent = totalPercent ?? (
      used !== null && limit !== undefined
        ? Math.min(100, Math.max(0, used / limit * 100))
        : null
    );
    if (usedPercent !== null) combinedPlan = { usedPercent, resetsAt };
  }

  return {
    planLabel: normalizePlanLabel(root.membershipType),
    cursorModels: cursorPercent === null ? null : { usedPercent: cursorPercent, resetsAt },
    otherModels: otherPercent === null ? null : { usedPercent: otherPercent, resetsAt },
    plan: combinedPlan,
  };
}

export function cursorRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

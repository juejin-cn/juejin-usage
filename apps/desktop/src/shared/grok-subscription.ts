export type GrokSubscriptionStatus =
  | 'ready'
  | 'custom-provider'
  | 'not-installed'
  | 'not-signed-in'
  | 'unsupported-version'
  | 'temporarily-unavailable';

export interface GrokRateLimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface GrokSubscriptionSnapshot {
  status: GrokSubscriptionStatus;
  planLabel: string | null;
  limits: GrokRateLimitWindow[];
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

function parseDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1_000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  // xAI sometimes emits more than three fractional-second digits.
  const normalized = value.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})$)/, '$1');
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

function periodKind(type: unknown, durationSeconds: number | null): string {
  const token = typeof type === 'string' ? type.toUpperCase() : '';
  if (token.includes('HOUR') || token.includes('SESSION')) return 'session';
  if (token.includes('DAY')) return 'daily';
  if (token.includes('WEEK')) return 'weekly';
  if (token.includes('MONTH')) return 'monthly';
  if (token.includes('BILLING') || token.includes('CYCLE')) return 'billing';
  if (durationSeconds !== null) {
    if (durationSeconds <= 8 * 60 * 60) return 'session';
    if (durationSeconds <= 36 * 60 * 60) return 'daily';
    if (durationSeconds <= 8.5 * 24 * 60 * 60) return 'weekly';
    if (durationSeconds <= 45 * 24 * 60 * 60) return 'monthly';
    return 'billing';
  }
  return 'unknown';
}

function periodLabel(kind: string, durationSeconds: number | null): string {
  if (kind === 'session') {
    const hours = durationSeconds === null ? 5 : Math.max(1, Math.round(durationSeconds / 3_600));
    return `${hours}h`;
  }
  if (kind === 'daily') return '1d';
  if (kind === 'weekly') return '7d';
  if (kind === 'monthly') return '30d';
  if (kind === 'billing') return '周期';
  return '额度';
}

function planLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const labels: Record<string, string> = {
    supergrok: 'SuperGrok',
    supergrokheavy: 'SuperGrok Heavy',
    free: 'Free',
    premium: 'Premium',
  };
  return labels[normalized] ?? value.trim();
}

function readPercent(config: Record<string, unknown>): number | null {
  const explicit = boundedPercent(
    config.creditUsagePercent ?? config.usagePercent ?? config.creditsUsedPercent,
  );
  if (explicit !== null) return explicit;
  const credits = asRecord(
    config.usage ?? config.credits ?? config.latestHistory ?? config.billingCycle,
  );
  const monthlyLimit = finiteNumber(config.monthlyLimit ?? credits?.monthlyLimit ?? credits?.limit);
  const used = finiteNumber(
    config.totalUsed ?? config.includedUsed ?? credits?.totalUsed ?? credits?.includedUsed ?? credits?.used,
  );
  if (monthlyLimit === null || monthlyLimit <= 0 || used === null) return null;
  return Math.min(100, Math.max(0, used / monthlyLimit * 100));
}

interface NormalizedPeriod {
  kind: string;
  durationSeconds: number | null;
  start: Date | null;
  end: Date | null;
  usedPercent: number | null;
}

function normalizePeriod(value: unknown): NormalizedPeriod | null {
  const record = asRecord(value);
  if (!record) return null;
  const start = parseDate(record.start ?? record.startDate ?? record.startTime ?? record.periodStart);
  const end = parseDate(record.end ?? record.endDate ?? record.endTime ?? record.periodEnd);
  const durationSeconds = start && end && end > start
    ? (end.getTime() - start.getTime()) / 1_000
    : null;
  return {
    kind: periodKind(record.type ?? record.periodType ?? record.kind, durationSeconds),
    durationSeconds,
    start,
    end,
    usedPercent: boundedPercent(
      record.usagePercent ?? record.percent ?? record.usedPercent ?? record.utilizationPercent,
    ),
  };
}

/** Normalize the Grok Build ACP billing payload without retaining credential data. */
export function mapGrokBilling(value: unknown): Pick<
  GrokSubscriptionSnapshot,
  'planLabel' | 'limits'
> {
  const root = asRecord(value);
  if (!root) return { planLabel: null, limits: [] };
  const namedConfig = asRecord(root.config ?? root.billingConfig ?? root.billing);
  const config = namedConfig ?? root;
  const rawPeriods = Array.isArray(config.usagePeriods)
    ? config.usagePeriods
    : Array.isArray(config.periods)
      ? config.periods
      : Array.isArray(config.quotaPeriods)
        ? config.quotaPeriods
        : Array.isArray(config.rateLimits)
          ? config.rateLimits
          : [];
  const reportedPercent = readPercent(config);
  const hasBillingShape = rawPeriods.length > 0
    || asRecord(config.currentPeriod ?? config.period) !== null
    || config.billingPeriodStart != null
    || config.billingPeriodEnd != null
    || config.isUnifiedBillingUser != null;
  // Proto3 omits scalar zeroes. Only a named/populated billing config is strong
  // enough evidence to interpret a missing percentage as a real 0% reading.
  const accountPercent = reportedPercent ?? (namedConfig && hasBillingShape ? 0 : null);
  const periods = rawPeriods
    .map(normalizePeriod)
    .filter((period): period is NormalizedPeriod => period !== null);

  if (periods.length === 0) {
    const current = normalizePeriod(config.currentPeriod ?? config.period);
    if (current) periods.push(current);
    else if (config.billingPeriodStart != null || config.billingPeriodEnd != null) {
      const fallback = normalizePeriod({
        type: 'billing',
        start: config.billingPeriodStart,
        end: config.billingPeriodEnd,
      });
      if (fallback) periods.push(fallback);
    }
  }

  const seenKinds = new Set<string>();
  const limits = periods
    .sort((left, right) => (left.durationSeconds ?? Number.MAX_SAFE_INTEGER) - (right.durationSeconds ?? Number.MAX_SAFE_INTEGER))
    .flatMap((period) => {
      if (seenKinds.has(period.kind)) return [];
      const canUseAccountPercent = period.kind !== 'session' && period.kind !== 'daily';
      const usedPercent = period.usedPercent ?? (canUseAccountPercent ? accountPercent : null);
      if (usedPercent === null) return [];
      seenKinds.add(period.kind);
      return [{
        id: period.kind,
        label: periodLabel(period.kind, period.durationSeconds),
        usedPercent,
        resetsAt: period.end ? Math.floor(period.end.getTime() / 1_000) : null,
      }];
    })
    .slice(0, 2);

  return {
    planLabel: planLabel(root.subscriptionTier ?? config.subscriptionTier ?? root.tier ?? root.plan),
    limits,
  };
}

export function grokRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

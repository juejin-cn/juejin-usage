/**
 * Browser-safe projection used by every dashboard trend chart.
 *
 * `totalTokens` is the authoritative aggregate supplied by the local API.
 * Input/cache/output are a breakdown, so any remaining tokens are retained as
 * `otherTokens` instead of silently changing the total drawn by a chart.
 */
export interface UsageTrendDailyBucket {
  date: string;
  dateLabel: string;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageTrendHourlyBucket {
  hour: number;
  /** Uncached input only — same column as the local hourly API. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageTrendChartPoint {
  /** Full date for daily points and `Nh` for hourly points. */
  label: string;
  /** Compact display label for the bar/area trend chart. */
  dateLabel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  otherTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** Metric-card fields shared by daily and hourly dashboard buckets. */
export interface UsageMetricTrendPoint {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageMetricTrendValues {
  costUsd: number[];
  inputTokens: number[];
  outputTokens: number[];
  totalTokens: number[];
}

/**
 * Preserve the exact ordered buckets used by a range when drawing metric-card
 * sparklines. Every client consumes this projection so a card cannot show a
 * summary for one range and a trend line from another range.
 */
export function buildUsageMetricTrendValues(
  rows: readonly UsageMetricTrendPoint[],
): UsageMetricTrendValues {
  return {
    costUsd: rows.map((row) => row.costUsd),
    totalTokens: rows.map((row) => row.totalTokens),
    inputTokens: rows.map((row) => row.inputTokens),
    outputTokens: rows.map((row) => row.outputTokens),
  };
}

export function buildUsageTrendChartRows({
  dailyRows,
  hourly,
  hourlyRows,
}: {
  dailyRows: readonly UsageTrendDailyBucket[];
  hourly: boolean;
  hourlyRows: readonly UsageTrendHourlyBucket[];
}): UsageTrendChartPoint[] {
  if (hourly) {
    return [...hourlyRows]
      .sort((left, right) => left.hour - right.hour)
      .map((row) =>
        buildUsageTrendChartPoint({
          label: `${row.hour}h`,
          dateLabel: `${row.hour}h`,
          // Hourly API / filled rows already store uncached input; cache is a
          // separate column. Subtracting again zeros the 输入 series whenever
          // cache reads exceed fresh input (the common cached-turn shape).
          inputTokens: Math.max(0, row.inputTokens),
          cachedInputTokens: Math.max(0, row.cachedInputTokens),
          outputTokens: row.outputTokens,
          totalTokens: row.totalTokens,
          costUsd: row.costUsd,
        }),
      );
  }

  return dailyRows.map((row) =>
    buildUsageTrendChartPoint({
      label: row.date,
      dateLabel: row.dateLabel,
      inputTokens: row.uncachedInputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd,
    }),
  );
}

function buildUsageTrendChartPoint(
  point: Omit<UsageTrendChartPoint, 'otherTokens'>,
): UsageTrendChartPoint {
  return {
    ...point,
    otherTokens: Math.max(
      0,
      point.totalTokens -
        point.inputTokens -
        point.cachedInputTokens -
        point.outputTokens,
    ),
  };
}

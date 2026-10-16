import type { UsageDataset } from './api';

/**
 * Cheap content fingerprint so reload/poll can keep the previous React
 * `data` reference when usage has not changed (avoids Recharts/heatmap rebuild).
 */
export function fingerprintUsageDataset(
  dataset: UsageDataset,
  rangeDays: number,
): string {
  const daily = dataset.dailyRows;
  const first = daily[0];
  const last = daily[daily.length - 1];
  let modelTokens = 0;
  for (const row of dataset.modelRows) modelTokens += row.tokens;
  let hourlyTokens = 0;
  for (const row of dataset.hourlyRows) hourlyTokens += row.tokens;

  return [
    rangeDays,
    dataset.summary.totalTokens,
    dataset.summary.todayTokens,
    Math.round(dataset.summary.totalCostUsd * 100),
    daily.length,
    first?.date ?? '',
    last?.date ?? '',
    last?.tokens ?? 0,
    dataset.hourlyRows.length,
    hourlyTokens,
    dataset.modelRows.length,
    modelTokens,
    dataset.syncStatus?.lastSyncAt ?? '',
  ].join('|');
}

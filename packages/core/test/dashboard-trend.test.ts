import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUsageMetricTrendValues,
  buildUsageTrendChartRows,
} from '../src/dashboard-trend.js';

test('preserves the authoritative daily total and exposes unallocated tokens', () => {
  const [row] = buildUsageTrendChartRows({
    hourly: false,
    hourlyRows: [],
    dailyRows: [
      {
        date: '2026-09-10',
        dateLabel: '9/10',
        uncachedInputTokens: 30,
        cachedInputTokens: 20,
        outputTokens: 40,
        totalTokens: 100,
        costUsd: 0.42,
      },
    ],
  });

  assert.deepEqual(row, {
    label: '2026-09-10',
    dateLabel: '9/10',
    inputTokens: 30,
    cachedInputTokens: 20,
    outputTokens: 40,
    otherTokens: 10,
    totalTokens: 100,
    costUsd: 0.42,
  });
});

test('sorts hourly buckets and derives uncached input without changing totals', () => {
  const rows = buildUsageTrendChartRows({
    hourly: true,
    dailyRows: [],
    hourlyRows: [
      {
        hour: 12,
        inputTokens: 50,
        cachedInputTokens: 15,
        outputTokens: 30,
        totalTokens: 100,
        costUsd: 0.8,
      },
      {
        hour: 3,
        inputTokens: 10,
        cachedInputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        costUsd: 0.1,
      },
    ],
  });

  assert.deepEqual(rows, [
    {
      label: '3h',
      dateLabel: '3h',
      inputTokens: 0,
      cachedInputTokens: 12,
      outputTokens: 8,
      otherTokens: 0,
      totalTokens: 20,
      costUsd: 0.1,
    },
    {
      label: '12h',
      dateLabel: '12h',
      inputTokens: 35,
      cachedInputTokens: 15,
      outputTokens: 30,
      otherTokens: 20,
      totalTokens: 100,
      costUsd: 0.8,
    },
  ]);
});

test('keeps every metric-card series aligned to the selected buckets', () => {
  const values = buildUsageMetricTrendValues([
    {
      costUsd: 0.12,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 35,
    },
    {
      costUsd: 0.34,
      inputTokens: 30,
      outputTokens: 40,
      totalTokens: 75,
    },
  ]);

  assert.deepEqual(values, {
    costUsd: [0.12, 0.34],
    totalTokens: [35, 75],
    inputTokens: [10, 30],
    outputTokens: [20, 40],
  });
});

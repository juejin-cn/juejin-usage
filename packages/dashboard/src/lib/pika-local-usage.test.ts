import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyLocalMetrics,
  mergeLocalMetrics,
} from '@juejin-opensource/jusage-core/local-metrics';
import {
  addLocalDays,
  localDateNow,
} from '@juejin-opensource/jusage-core/timezone';
import { dailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import {
  buildDashboardDataFromDataset,
  buildFilledHourlyForDate,
  projectDashboardForDate,
} from './dashboard-data.ts';
import { filterTrendRowsBySources } from './usage-filter.ts';
import { sumLocalMetrics } from './local-usage.ts';
import { fingerprintUsageDataset } from './usage-dataset-fingerprint.ts';
import type { UsageDataset } from './api.ts';

function pikaDataset(): UsageDataset {
  const date = localDateNow();
  const claude = {
    ...emptyLocalMetrics(),
    uncachedInputTokens: 100,
    cacheReadTokens: 600,
    cacheWriteTokens: 300,
    outputTokens: 80,
    reasoningOutputTokens: 20,
    requestCount: 2,
    knownRequestCount: 2,
    cacheHitRate: 0.6,
  };
  const cursor = {
    ...emptyLocalMetrics(),
    uncachedInputTokens: 400,
    outputTokens: 100,
    requestCount: 10,
    knownRequestCount: 10,
    cacheHitRate: 0,
  };
  const localMetrics = mergeLocalMetrics([claude, cursor]);
  const sources = [
    { source: 'claude', tokens: 1100, costUsd: 1, localMetrics: claude },
    { source: 'cursor', tokens: 500, costUsd: 2, localMetrics: cursor },
  ];
  return {
    summary: {
      totalTokens: 1600,
      totalCostUsd: 3,
      todayTokens: 1600,
      todayCostUsd: 3,
      statsSince: '2020-01-01',
      bySource: [],
      localMetrics,
    },
    dailyRows: [
      {
        date,
        tokens: 1600,
        costUsd: 3,
        localMetrics,
        sources,
        models: {
          [dailyModelKey('claude', 'pika-model')]: 1100,
          [dailyModelKey('cursor', 'pika-model')]: 500,
        },
      },
    ],
    hourlyRows: sources.map((row) => ({
      ...row,
      date,
      hour: 0,
      inputTokens: row.localMetrics.uncachedInputTokens,
      outputTokens: row.localMetrics.outputTokens,
      cachedInputTokens: row.localMetrics.cacheReadTokens ?? 0,
    })),
    modelRows: sources.map((row) => ({
      ...row,
      model: 'pika-model',
      pct: row.tokens / 16,
    })),
    projectRows: [],
    syncStatus: null,
  };
}

test('pika local daily and hourly values reconcile without template ratios or cache clipping', () => {
  const dataset = pikaDataset();
  const data = buildDashboardDataFromDataset(dataset, 7, true);
  assert.equal(data.summary.inputTokens, 1400);
  assert.equal(data.summary.outputTokens, 200);
  assert.equal(data.summary.localMetrics?.requestCount, 12);
  assert.equal(data.summary.localMetrics?.cacheHitRate, 600 / 1400);
  const hours = buildFilledHourlyForDate(
    dataset.hourlyRows,
    localDateNow(),
    23,
    true,
  );
  assert.equal(hours[0]?.cachedInputTokens, 600);
  assert.deepEqual(sumLocalMetrics(hours), data.summary.localMetrics);
  assert.deepEqual(
    projectDashboardForDate(data, localDateNow()).summary.localMetrics,
    data.summary.localMetrics,
  );
  assert.equal(
    projectDashboardForDate(data, addLocalDays(localDateNow(), -1)).summary
      .localMetrics?.requestCount,
    0,
  );
});

test('pika selecting a source uses actual requests and cache data for both time granularities', () => {
  const data = buildDashboardDataFromDataset(pikaDataset(), 7, true);
  const filtered = filterTrendRowsBySources({
    dailyRows: data.rangeDailyUsage,
    hourlyRows: data.todayHourlyUsage,
    hourlyApiRows: data.hourlyApiRows,
    heatmapDays: data.heatmapDays,
    modelRows: data.modelRows,
    toolRows: data.toolModelUsage,
    selectedSources: ['claude'],
    hourlyDate: localDateNow(),
  });
  assert.equal(filtered.dailyRows[0]?.totalTokens, 1100);
  assert.equal(filtered.dailyRows[0]?.localMetrics?.requestCount, 2);
  assert.equal(filtered.dailyRows[0]?.localMetrics?.cacheHitRate, 0.6);
  assert.deepEqual(
    sumLocalMetrics(filtered.hourlyRows),
    sumLocalMetrics(filtered.dailyRows),
  );
});

test('pika empty local ranges are zero while missing contract and legacy requests remain unknown', () => {
  const dataset = pikaDataset();
  dataset.dailyRows = [];
  dataset.hourlyRows = [];
  dataset.summary.localMetrics = emptyLocalMetrics();
  assert.equal(
    buildDashboardDataFromDataset(dataset, 1, true).summary.localMetrics
      ?.requestCount,
    0,
  );
  delete dataset.summary.localMetrics;
  assert.equal(
    buildDashboardDataFromDataset(dataset, 1, true).summary.localMetrics
      ?.requestCount,
    null,
  );
  const historical = pikaDataset();
  historical.dailyRows[0]!.date = addLocalDays(localDateNow(), -2);
  assert.equal(
    buildDashboardDataFromDataset(historical, 1, true).summary.localMetrics
      ?.requestCount,
    0,
  );
  const partial = pikaDataset();
  partial.dailyRows[0]!.localMetrics!.requestCount = null;
  assert.equal(
    buildDashboardDataFromDataset(partial, 7, true).summary.localMetrics
      ?.requestCount,
    null,
  );
});

test('pika metadata-only corrections invalidate the dashboard fingerprint', () => {
  const dataset = pikaDataset();
  const before = fingerprintUsageDataset(dataset, 7);
  dataset.dailyRows[0]!.localMetrics!.requestCount = 99;
  assert.notEqual(fingerprintUsageDataset(dataset, 7), before);
});

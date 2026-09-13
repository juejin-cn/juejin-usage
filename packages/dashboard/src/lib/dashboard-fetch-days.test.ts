import assert from 'node:assert/strict';
import test from 'node:test';

import { HEATMAP_LOOKBACK_DAYS } from './dashboard-mock-data.ts';
import { resolveDashboardFetchDays } from './dashboard-fetch-days.ts';

test('breakdown/hourly follow selected range while daily keeps heatmap lookback', () => {
  assert.equal(HEATMAP_LOOKBACK_DAYS, 365);

  assert.deepEqual(resolveDashboardFetchDays(1), {
    dailyDays: 365,
    breakdownDays: 1,
    hourlyDays: 2,
  });
  assert.deepEqual(resolveDashboardFetchDays(7), {
    dailyDays: 365,
    breakdownDays: 7,
    hourlyDays: 7,
  });
  assert.deepEqual(resolveDashboardFetchDays(30), {
    dailyDays: 365,
    breakdownDays: 30,
    hourlyDays: 30,
  });
  assert.deepEqual(resolveDashboardFetchDays(90), {
    dailyDays: 365,
    breakdownDays: 90,
    hourlyDays: 90,
  });
});

test('dailyDays grows with range when range exceeds heatmap lookback', () => {
  assert.deepEqual(resolveDashboardFetchDays(400), {
    dailyDays: 400,
    breakdownDays: 400,
    hourlyDays: 400,
  });
});

test('hourlyDays expands to cover a heatmap date outside the range', () => {
  // Shanghai 2026-08-13 12:00
  const now = new Date('2026-08-13T04:00:00.000Z');
  assert.deepEqual(resolveDashboardFetchDays(7, '2026-08-05', now), {
    dailyDays: 365,
    breakdownDays: 7,
    hourlyDays: 10,
  });
  assert.deepEqual(resolveDashboardFetchDays(7, '2026-08-12', now), {
    dailyDays: 365,
    breakdownDays: 7,
    hourlyDays: 7,
  });
  assert.deepEqual(resolveDashboardFetchDays(1, '2026-08-13', now), {
    dailyDays: 365,
    breakdownDays: 1,
    hourlyDays: 2,
  });
});

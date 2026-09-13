import assert from 'node:assert/strict';
import test from 'node:test';
import { grokRemainingPercent, mapGrokBilling } from './grok-subscription';

test('maps a weekly Grok billing response with microsecond dates', () => {
  assert.deepEqual(mapGrokBilling({
    config: {
      creditUsagePercent: 27.5,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-09-01T00:00:00.123456+00:00',
        end: '2026-09-08T00:00:00.123456+00:00',
      },
      subscriptionTier: 'SuperGrok',
    },
  }), {
    planLabel: 'SuperGrok',
    limits: [{ id: 'weekly', label: '7d', usedPercent: 27.5, resetsAt: 1_788_825_600 }],
  });
});

test('keeps distinct short and long periods and their own percentages', () => {
  const result = mapGrokBilling({
    subscriptionTier: 'SuperGrok Heavy',
    billingConfig: {
      usagePeriods: [
        { type: 'weekly', usagePercent: 75, end: '2026-09-14T00:00:00Z' },
        { type: 'session', usagePercent: -2, start: '2026-09-08T00:00:00Z', end: '2026-09-08T05:00:00Z' },
      ],
    },
  });
  assert.equal(result.planLabel, 'SuperGrok Heavy');
  assert.deepEqual(result.limits.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })), [
    { id: 'session', label: '5h', usedPercent: 0 },
    { id: 'weekly', label: '7d', usedPercent: 75 },
  ]);
});

test('derives monthly utilization from credits when percent is absent', () => {
  assert.deepEqual(mapGrokBilling({
    config: {
      billingPeriodStart: '2026-09-01T00:00:00Z',
      billingPeriodEnd: '2026-10-01T00:00:00Z',
      credits: { monthlyLimit: 1000, totalUsed: 250 },
    },
  }).limits, [{
    id: 'billing',
    label: '周期',
    usedPercent: 25,
    resetsAt: 1_790_812_800,
  }]);
});

test('treats an omitted proto percent as zero without inventing a session reading', () => {
  assert.deepEqual(mapGrokBilling({
    config: {
      usagePeriods: [
        { type: 'session', start: '2026-09-08T00:00:00Z', end: '2026-09-08T05:00:00Z' },
        { type: 'weekly', end: '2026-09-14T00:00:00Z' },
      ],
    },
  }).limits, [{
    id: 'weekly',
    label: '7d',
    usedPercent: 0,
    resetsAt: 1_789_344_000,
  }]);
});

test('converts Grok usage to remaining allowance', () => {
  assert.equal(grokRemainingPercent(0), 100);
  assert.equal(grokRemainingPercent(88), 12);
  assert.equal(grokRemainingPercent(140), 0);
});

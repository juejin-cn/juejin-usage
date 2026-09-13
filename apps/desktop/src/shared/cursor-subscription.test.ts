import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorRemainingPercent, mapCursorUsageSummary } from './cursor-subscription';

test('maps current Cursor model pools from individual usage', () => {
  assert.deepEqual(mapCursorUsageSummary({
    billingCycleEnd: '2026-10-01T00:00:00Z',
    membershipType: 'ultra',
    individualUsage: {
      plan: { autoPercentUsed: 21.5, apiPercentUsed: 72 },
    },
  }), {
    planLabel: 'Ultra',
    cursorModels: { usedPercent: 21.5, resetsAt: 1_790_812_800 },
    otherModels: { usedPercent: 72, resetsAt: 1_790_812_800 },
    plan: null,
  });
});

test('falls back to team usage and bounds pool percentages', () => {
  const result = mapCursorUsageSummary({
    billingCycleEnd: 1_800_000_000_000,
    teamUsage: { plan: { autoPercentUsed: -5, apiPercentUsed: 130 } },
  });
  assert.deepEqual(result.cursorModels, { usedPercent: 0, resetsAt: 1_800_000_000 });
  assert.deepEqual(result.otherModels, { usedPercent: 100, resetsAt: 1_800_000_000 });
});

test('maps legacy used and limit response into one plan window', () => {
  assert.deepEqual(mapCursorUsageSummary({
    membershipType: 'pro',
    individualUsage: { plan: { used: 125, breakdown: { total: 500 } } },
  }), {
    planLabel: 'Pro',
    cursorModels: null,
    otherModels: null,
    plan: { usedPercent: 25, resetsAt: null },
  });
});

test('converts Cursor usage to remaining allowance', () => {
  assert.equal(cursorRemainingPercent(0), 100);
  assert.equal(cursorRemainingPercent(66.5), 33.5);
  assert.equal(cursorRemainingPercent(120), 0);
});

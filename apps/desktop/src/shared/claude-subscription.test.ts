import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claudePlanLabel,
  claudeRemainingPercent,
  mapClaudeUsageWindows,
} from './claude-subscription';

test('maps Claude five-hour and seven-day OAuth usage windows', () => {
  assert.deepEqual(mapClaudeUsageWindows({
    five_hour: { utilization: 18.5, resets_at: '2026-09-08T12:00:00Z' },
    seven_day: { utilization: 73, resets_at: '2026-09-12T00:00:00Z' },
  }), {
    fiveHour: { usedPercent: 18.5, resetsAt: 1_788_868_800 },
    sevenDay: { usedPercent: 73, resetsAt: 1_789_171_200 },
  });
});

test('keeps partial usage responses usable and bounds percentages', () => {
  assert.deepEqual(mapClaudeUsageWindows({
    five_hour: { utilization: 140, resets_at: 'invalid' },
  }), {
    fiveHour: { usedPercent: 100, resetsAt: null },
    sevenDay: null,
  });
  assert.deepEqual(mapClaudeUsageWindows({ seven_day: {} }), {
    fiveHour: null,
    sevenDay: null,
  });
});

test('converts usage to remaining allowance and normalizes plan labels', () => {
  assert.equal(claudeRemainingPercent(0), 100);
  assert.equal(claudeRemainingPercent(72.5), 27.5);
  assert.equal(claudeRemainingPercent(130), 0);
  assert.equal(claudeRemainingPercent(Number.NaN), 0);
  assert.equal(claudePlanLabel('max_20x'), 'Max 20x');
  assert.equal(claudePlanLabel('unknown-tier'), 'Claude.ai');
  assert.equal(claudePlanLabel(null), null);
});

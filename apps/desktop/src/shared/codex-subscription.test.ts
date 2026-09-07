import assert from 'node:assert/strict';
import test from 'node:test';
import { codexPlanLabel, mapCodexRateLimitWindows } from './codex-subscription';

test('maps Codex five-hour and weekly windows by duration, not position', () => {
  const result = mapCodexRateLimitWindows({
    primary: { usedPercent: 81, resetsAt: 1_700_000_000, windowDurationMins: 10_080 },
    secondary: { usedPercent: 20, resetsAt: 1_699_000_000, windowDurationMins: 300 },
  });
  assert.deepEqual(result.fiveHour, { usedPercent: 20, resetsAt: 1_699_000_000 });
  assert.deepEqual(result.weekly, { usedPercent: 81, resetsAt: 1_700_000_000 });
});

test('keeps unknown-duration windows out of the tray contract', () => {
  const result = mapCodexRateLimitWindows({ primary: { usedPercent: 40, windowDurationMins: 60 } });
  assert.equal(result.fiveHour, null);
  assert.equal(result.weekly, null);
});

test('normalizes plan labels and progress boundaries', () => {
  assert.equal(codexPlanLabel('plus'), 'Plus');
  assert.equal(codexPlanLabel('unlisted-plan'), 'ChatGPT');
  const result = mapCodexRateLimitWindows({ primary: { usedPercent: 140, resetsAt: 0, windowDurationMins: 300 } });
  assert.deepEqual(result.fiveHour, { usedPercent: 100, resetsAt: null });
});

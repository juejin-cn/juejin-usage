import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCompactTokens, formatTrayUsage, isTrayUsageMode } from './tray-usage';

test('formats compact token counts', () => {
  assert.equal(formatCompactTokens(0), '0');
  assert.equal(formatCompactTokens(-10), '0');
  assert.equal(formatCompactTokens(500), '500');
  assert.equal(formatCompactTokens(1000), '1K');
  assert.equal(formatCompactTokens(1500), '1.5K');
  assert.equal(formatCompactTokens(25000), '25K');
  assert.equal(formatCompactTokens(1200000), '1.2M');
  assert.equal(formatCompactTokens(1000000000), '1B');
});

test('formats tray usage with cost and tokens', () => {
  // Empty or zero
  assert.equal(formatTrayUsage({}), '0 Token · $0.00');
  assert.equal(formatTrayUsage({ todayCostUsd: 0, todayTokens: 0 }), '0 Token · $0.00');

  // Normal positive cost
  assert.equal(formatTrayUsage({ todayCostUsd: 1.25, todayTokens: 45000 }), '45K Token · $1.25');
  assert.equal(formatTrayUsage({ todayCostUsd: 12.8, todayTokens: 100000 }), '100K Token · $12.80');

  // Sub-cent cost
  assert.equal(formatTrayUsage({ todayCostUsd: 0.004, todayTokens: 500 }), '500 Token · <$0.01');

  // Free model (cost 0, but tokens > 0)
  assert.equal(formatTrayUsage({ todayCostUsd: 0, todayTokens: 45200 }), '45.2K Token · $0.00');
  assert.equal(formatTrayUsage({ todayCostUsd: 0, todayTokens: 800 }), '800 Token · $0.00');
});

test('formats each tray display mode', () => {
  const summary = { todayTokens: 8500000, todayCostUsd: 5.46 };
  assert.equal(formatTrayUsage(summary, 'both'), '8.5M Token · $5.46');
  assert.equal(formatTrayUsage(summary, 'tokens'), '8.5M Token');
  assert.equal(formatTrayUsage(summary, 'cost'), '$5.46');
  assert.equal(isTrayUsageMode('both'), true);
  assert.equal(isTrayUsageMode('other'), false);
});

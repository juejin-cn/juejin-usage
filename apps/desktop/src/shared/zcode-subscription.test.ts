import assert from 'node:assert/strict';
import test from 'node:test';
import { mapZcodeQuota, zcodeRemainingPercent } from './zcode-subscription';

test('maps ZCode Coding Plan quota pools and retains MCP outside tray selection', () => {
  const result = mapZcodeQuota({
    success: true,
    data: {
      level: 'pro',
      limits: [
        { type: 'TIME_LIMIT', percentage: 12, nextResetTime: 1_900_000_000_000 },
        { type: 'CREDIT_LIMIT', unit: 6, percentage: 40, nextResetTime: 1_900_000_000_000 },
        { type: 'CREDIT_LIMIT', unit: 3, percentage: 25, nextResetTime: 1_900_000_000_000 },
      ],
    },
  });
  assert.equal(result.planLabel, 'Pro');
  assert.deepEqual(result.limits.map((limit) => [limit.id, limit.label, limit.usedPercent]), [
    ['five-hour', '5h', 25],
    ['weekly', '7d', 40],
    ['mcp', 'MCP', 12],
  ]);
});

test('clamps ZCode remaining percentage', () => {
  assert.equal(zcodeRemainingPercent(0), 100);
  assert.equal(zcodeRemainingPercent(81), 19);
  assert.equal(zcodeRemainingPercent(120), 0);
});

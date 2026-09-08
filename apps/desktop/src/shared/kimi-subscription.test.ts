import assert from 'node:assert/strict';
import test from 'node:test';
import { kimiRemainingPercent, mapKimiUsage } from './kimi-subscription';

test('maps Kimi Code summary and rolling limits to compact windows', () => {
  const limits = mapKimiUsage({
    usage: { used: '20', limit: '100', resetTime: '2030-01-01T00:00:00Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { used: '30', limit: '120', resetTime: '2030-01-02T00:00:00Z' },
      },
    ],
  });

  assert.deepEqual(limits.map((limit) => [limit.label, limit.usedPercent]), [
    ['5h', 25],
    ['7d', 20],
  ]);
});

test('clamps Kimi remaining percentage', () => {
  assert.equal(kimiRemainingPercent(0), 100);
  assert.equal(kimiRemainingPercent(82.5), 17.5);
  assert.equal(kimiRemainingPercent(120), 0);
});

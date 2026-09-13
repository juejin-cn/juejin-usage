import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravityRemainingPercent, mapAntigravityModels } from './antigravity-subscription';

test('maps the two least consumed official Antigravity model pools', () => {
  const limits = mapAntigravityModels({
    models: {
      gemini: { displayName: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 0.32, resetTime: '2027-01-01T00:00:00Z' } },
      claude: { label: 'Claude Sonnet', quotaInfo: { remainingFraction: 0.81 } },
      exhausted: { label: 'Exhausted', quotaInfo: { remainingFraction: 0 } },
    },
  });
  assert.deepEqual(limits.map((limit) => [limit.id, limit.label, limit.usedPercent]), [
    ['claude', 'Claude Sonnet', 19],
    ['gemini', 'Gemini 3 Pro', 68],
  ]);
  assert.equal(limits[1].resetsAt, 1_798_761_600);
});

test('clamps Antigravity remaining percentage', () => {
  assert.equal(antigravityRemainingPercent(24), 76);
  assert.equal(antigravityRemainingPercent(150), 0);
});

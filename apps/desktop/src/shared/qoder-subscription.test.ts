import assert from 'node:assert/strict';
import test from 'node:test';
import { mapQoderQuota, qoderRemainingPercent } from './qoder-subscription';

test('maps Qoder official personal and add-on credit pools only', () => {
  const mapped = mapQoderQuota({
    data: {
      userQuota: { total: 1_000, used: 250 },
      addOnQuota: { percentage: 0.195 },
      orgResourcePackage: { percentage: 3 },
      expiresAt: 1_900_000_000,
    },
  }, { data: { planTierName: 'Qoder Pro' } });
  assert.equal(mapped.planLabel, 'Qoder Pro');
  assert.deepEqual(mapped.limits.map((limit) => [limit.id, limit.label, limit.usedPercent]), [
    ['plan', '套餐', 25],
    ['add-on', '加购', 19.5],
  ]);
  assert.equal(mapped.limits[0].resetsAt, 1_900_000_000);
});

test('clamps Qoder remaining percentage', () => {
  assert.equal(qoderRemainingPercent(0), 100);
  assert.equal(qoderRemainingPercent(71), 29);
  assert.equal(qoderRemainingPercent(150), 0);
});

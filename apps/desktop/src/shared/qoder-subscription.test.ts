import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapQoderQuota,
  qoderRemainingPercent,
  qoderSubscriptionFeedback,
} from './qoder-subscription';

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

test('uses the cached quota response membership type when the plan endpoint is unavailable', () => {
  const mapped = mapQoderQuota({
    userType: 'personal_professional',
    userQuota: { total: 1_000, used: 250 },
  }, null);

  assert.equal(mapped.planLabel, 'Pro');
});

test('clamps Qoder remaining percentage', () => {
  assert.equal(qoderRemainingPercent(0), 100);
  assert.equal(qoderRemainingPercent(71), 29);
  assert.equal(qoderRemainingPercent(150), 0);
});

test('hides Qoder when unavailable because it is not installed or signed in', () => {
  assert.equal(qoderSubscriptionFeedback({
    status: 'not-signed-in',
    planLabel: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message: '请先登录 Qoder',
  }), null);

  assert.equal(qoderSubscriptionFeedback({
    status: 'not-installed',
    planLabel: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message: '未检测到本机 Qoder',
  }), null);
});

test('keeps logged-in Qoder subscription failures visible when no quota is available', () => {
  assert.equal(qoderSubscriptionFeedback({
    status: 'temporarily-unavailable',
    planLabel: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message: '已登录 Qoder，但暂时无法读取订阅额度',
  }), '已登录 Qoder，但暂时无法读取订阅额度');

  assert.equal(qoderSubscriptionFeedback({
    status: 'ready',
    planLabel: 'Pro',
    limits: [{ id: 'plan', label: '套餐', usedPercent: 25, resetsAt: null }],
    fetchedAt: 1_900_000_000,
    stale: false,
    message: '使用 Qoder CLI 最近同步的额度',
  }), null);
});

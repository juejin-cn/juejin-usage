import assert from 'node:assert/strict';
import test from 'node:test';
import { traeChannel } from '../src/agent-router/channels/trae.js';
import { readSubscriptionDetails } from '../src/agent-router/usage.js';

const auth = { type: 'oauth', access: 'test-access', uid: 'test-user', deviceId: '1234567890123456', machineId: 'test-machine', accountName: 'Test' };
const pack = (quota: object, usage: object, end_time?: unknown) => ({ entitlement_base_info: { quota, end_time }, usage });

test('Trae CN queries the logged-in account and exposes combined credits through the usage pipeline', async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Cloud-IDE-JWT test-access');
    assert.deepEqual(JSON.parse(String(init?.body)), { require_usage: true, req_source: 0 });
    return Response.json({ user_entitlement_pack_list: [
      pack({ credits_limit: 300 }, { credits_amount: 75 }, 1790000000),
      pack({ credits_limit: '100' }, { credits_amount: '25' }, 1800000000000),
      pack({}, {}),
    ] });
  };
  const result = await readSubscriptionDetails('trae-cn', traeChannel(false, fetcher), async () => auth);
  assert.equal(result.state, 'available');
  assert.equal(result.accountName, 'Test');
  assert.deepEqual(result.windows, [{ used: 100, limit: 400, remaining: 300, percent: 25, unit: 'credits', resetsAt: new Date(1790000000000).toISOString() }]);
});

for (const region of ['sg', 'us']) {
  test(`Trae Global ${region} queries its billing region and combines basic and bonus dollars`, async () => {
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(String(url), `https://${region === 'us' ? 'api-us-east' : 'api-sg-central'}.trae.ai/trae/api/v1/pay/user_current_entitlement_list`);
      assert.deepEqual(JSON.parse(String(init?.body)), {});
      return Response.json({ data: { user_entitlement_pack_list: [pack({ basic_usage_limit: '20', bonus_usage_limit: 5 }, { basic_usage_amount: 4, bonus_usage_amount: 1 }, '2027-01-01T00:00:00Z')] } });
    };
    const result = await readSubscriptionDetails('trae-global', traeChannel(true, fetcher), async () => ({ ...auth, region }));
    assert.equal(result.state, 'available');
    assert.deepEqual(result.windows, [{ used: 5, limit: 25, remaining: 20, percent: 20, unit: 'USD', resetsAt: '2027-01-01T00:00:00.000Z' }]);
  });
}

test('Trae quota authentication errors do not become empty available quotas', async () => {
  for (const response of [() => Response.json({}, { status: 401 }), () => Response.json({ code: 1001 })]) {
    const result = await readSubscriptionDetails('trae-cn', traeChannel(false, async () => response()), async () => auth);
    assert.equal(result.state, 'expired');
    assert.deepEqual(result.windows, []);
  }
});

test('Trae malformed or refused quota responses report a quota error', async () => {
  for (const payload of [{ code: 500, message: 'upstream failed' }, {}, { user_entitlement_pack_list: {} }]) {
    const result = await readSubscriptionDetails('trae-cn', traeChannel(false, async () => Response.json(payload)), async () => auth);
    assert.equal(result.state, 'unknown');
    assert.equal(result.quotaError, true);
  }
});

test('Trae distinguishes exhausted credits from missing and unlimited allowances', async () => {
  for (const [packs, available] of [
    [[pack({ credits_limit: 100 }, { credits_amount: 125 })], true],
    [[pack({ credits_limit: 0 }, { credits_amount: 0 })], true],
    [[], false],
    [[pack({ credits_limit: -1 }, {}), pack({ credits_limit: 100 }, {})], false],
    [[pack({ credits_limit: null }, {})], false],
  ] as const) {
    const result = await readSubscriptionDetails('trae-cn', traeChannel(false, async () => Response.json({ user_entitlement_pack_list: packs })), async () => auth);
    assert.equal(result.state, available ? 'available' : 'unknown');
    if (available) {
      assert.equal(result.windows[0].remaining, 0);
      assert.ok((result.windows[0].percent ?? 0) <= 100);
    }
  }
});

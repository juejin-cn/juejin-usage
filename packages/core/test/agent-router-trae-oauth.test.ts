import assert from 'node:assert/strict';
import test from 'node:test';
import { traeChannel } from '../src/agent-router/channels/trae.js';
import type { LoginFlow } from '../src/agent-router/subscription-types.js';

for (const global of [false, true]) {
  test(`Trae ${global ? 'Global' : 'CN'} native authorization and browser callback`, async t => {
    const flow = await traeChannel(global).auth.methods[0].authorize!() as LoginFlow;
    const login = new URL(flow.url!);
    const q = login.searchParams;
    const callback = new URL(q.get('auth_callback_url')!);
    let finished = false;
    // Always settle the flow so a failed assertion leaves no listener/timer.
    t.after(async () => {
      if (!finished) {
        callback.search = '?error=access_denied';
        await fetch(callback).catch(() => {});
        await flow.callback().catch(() => {});
      }
    });
    assert.equal(login.origin, global ? 'https://www.trae.ai' : 'https://www.trae.cn');
    assert.equal(callback.hostname, '127.0.0.1');
    assert.equal(callback.pathname, '/authorize');
    assert.match(q.get('device_id')!, global ? /^[1-9]\d{18}$/ : /^[1-9]\d{15}$/);
    assert.match(q.get('machine_id')!, /^[a-f0-9]{32}$/);
    assert.equal(q.get('x_device_id'), q.get('device_id'));
    assert.equal(q.get('x_machine_id'), q.get('machine_id'));
    assert.ok(q.get('x_device_type'));
    assert.ok(q.get('x_os_version'));

    const rejected = await fetch(callback, { headers: { origin: 'https://unrelated.example' } });
    assert.equal(rejected.status, 404);
    const preflight = await fetch(callback, { method: 'OPTIONS', headers: {
      origin: login.origin, 'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type', 'access-control-request-private-network': 'true',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), login.origin);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    assert.equal((await fetch(callback)).status, 400);

    callback.searchParams.set('userJwt', JSON.stringify({ Token: 'fake-access', RefreshToken: 'fake-refresh' }));
    callback.searchParams.set('userInfo', JSON.stringify({ UserID: 'test-user', ScreenName: 'Test', ...(global ? { AIRegion: 'US' } : {}) }));
    assert.equal((await fetch(callback, { headers: { origin: login.origin } })).status, 200);
    const auth = await flow.callback();
    finished = true;
    assert.equal(auth.access, 'fake-access');
    assert.equal(auth.uid, 'test-user');
    assert.equal(auth.region, global ? 'us' : 'sg');
    assert.equal(auth.deviceId, q.get('device_id'));
    assert.equal(auth.machineId, q.get('machine_id'));
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { beginGithubDeviceGrant } from '../src/agent-router/native/github-device.js';

function fixture(replies: Record<string, unknown>[], expires = 90) {
  let now = 0; const waits: number[] = []; const requests: string[] = [];
  const fetcher = (async (url, init) => {
    requests.push(String(url)); assert.equal(init?.redirect, 'error');
    assert.equal(new URLSearchParams(String(init?.body)).get('client_id'), 'test-client');
    return Response.json(requests.length === 1
      ? { device_code: 'device', user_code: 'CODE', verification_uri: 'https://github.com/login/device', interval: 2, expires_in: expires }
      : replies.shift() ?? {});
  }) as typeof fetch;
  return { waits, requests, options: { origin: 'https://github.com', clientId: 'test-client', fetcher,
    now: () => now, wait: async (ms: number) => { waits.push(ms); now += ms; } } };
}

test('device grant observes polling intervals, slows down and shares the completion', async () => {
  const f = fixture([{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'test-token' }]);
  const flow = await beginGithubDeviceGrant(f.options);
  const first = flow.token(); assert.equal(flow.token(), first);
  assert.equal(await first, 'test-token'); assert.deepEqual(f.waits, [2000, 2000, 7000]);
});
test('expired grants do not send token requests after the deadline', async () => {
  const f = fixture([], 1); const flow = await beginGithubDeviceGrant(f.options);
  await assert.rejects(flow.token(), /LOGIN_TIMEOUT/); assert.equal(f.requests.length, 1);
});
test('cancelled grants do not poll and declined authorization is terminal', async () => {
  const f = fixture([]); const flow = await beginGithubDeviceGrant(f.options); flow.cancel();
  await assert.rejects(flow.token(), /CANCELLED/); assert.equal(f.requests.length, 1);
  const denied = await beginGithubDeviceGrant(fixture([{ error: 'access_denied' }]).options);
  await assert.rejects(denied.token(), /CANCELLED/);
});
test('unknown errors do not disclose upstream details or retry', async () => {
  const f = fixture([{ error: 'unexpected-secret' }]); const flow = await beginGithubDeviceGrant(f.options);
  await assert.rejects(flow.token(), /^Error: SUBSCRIPTION_LOGIN_FAILED$/); assert.equal(f.requests.length, 2);
});

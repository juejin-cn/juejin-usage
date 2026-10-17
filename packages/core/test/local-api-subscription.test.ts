import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptionApi } from '../src/server/subscription-api.js';
import type { readSubscription } from '../src/subscription/read.js';

const snapshot = { status: 'ready', planLabel: 'Plus', fiveHour: null, weekly: null,
  hasAccount: true, fetchedAt: 1800000000, stale: false, message: null };
function fixture(value: unknown = snapshot) {
  const calls: unknown[] = [];
  const reader = (async (channel, options) => {
    calls.push([channel, options]);
    if (value instanceof Error) throw value;
    return value;
  }) as typeof readSubscription;
  return { calls, app: createSubscriptionApi(reader) };
}
test('returns a snapshot and forwards only the exact forceRefresh value', async () => {
  for (const [query, forceRefresh] of [['', false], ['?forceRefresh=1', true], ['?forceRefresh=true', false]] as const) {
    const { app, calls } = fixture();
    const res = await app.request(`http://127.0.0.1:8452/codex${query}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: 'ok', data: snapshot });
    assert.deepEqual(calls, [['codex', { forceRefresh }]]);
  }
});
test('unknown channels never execute a reader', async () => {
  const { app, calls } = fixture();
  const res = await app.request('http://127.0.0.1:8452/unknown');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).message, 'UNKNOWN_SUBSCRIPTION_CHANNEL');
  assert.deepEqual(calls, []);
});
test('preserves Kimi arrays and business failure states', async () => {
  for (const data of [[snapshot], { ...snapshot, status: 'not-signed-in', planLabel: null }]) {
    const { app } = fixture(data);
    const res = await app.request('http://127.0.0.1:8452/kimi');
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, data);
  }
});
test('does not expose unexpected errors', async () => {
  const { app } = fixture(new Error('secret-token /private/auth.json'));
  const res = await app.request('http://127.0.0.1:8452/codex');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { success: false, message: 'SUBSCRIPTION_READ_FAILED', data: null });
});
test('allows same-origin and the CLI dev origins', async () => {
  for (const origin of ['http://127.0.0.1:8452', 'http://localhost:5194', 'http://127.0.0.1:5194']) {
    const { app } = fixture();
    const res = await app.request('http://127.0.0.1:8452/codex', { headers: { Origin: origin } });
    assert.equal(res.status, 200, origin);
  }
});
test('rejects foreign origins, cross-site requests and rebinding hosts before reading', async () => {
  for (const headers of [
    { Origin: 'https://evil.example' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'evil.example:8452' },
    { Origin: 'http://localhost:9999' }, { Host: 'localhost:8452@evil.example' },
  ] as Record<string, string>[]) {
    const { app, calls } = fixture();
    const res = await app.request('http://127.0.0.1:8452/codex', { headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.deepEqual(calls, []);
  }
  assert.equal((await fixture().app.request('http://evil.example/codex')).status, 403);
});
test('one failing channel does not block another concurrent channel', async () => {
  const app = createSubscriptionApi((async channel => {
    if (channel === 'cursor') throw new Error('failed');
    return snapshot;
  }) as typeof readSubscription);
  const [bad, good] = await Promise.all(['cursor', 'codex'].map(channel => app.request(`http://127.0.0.1:8452/${channel}`)));
  assert.equal(bad.status, 500);
  assert.equal(good.status, 200);
});

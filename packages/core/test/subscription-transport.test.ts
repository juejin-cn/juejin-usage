import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSubscription, setSubscriptionFetch } from '../src/subscription/transport.js';

test('subscription transport can be injected without Electron', async () => {
  const calls: string[] = [];
  setSubscriptionFetch(async input => {
    calls.push(String(input));
    return Response.json({ ok: true });
  });
  try {
    assert.deepEqual(await (await fetchSubscription('https://example.invalid/usage')).json(), { ok: true });
    assert.deepEqual(calls, ['https://example.invalid/usage']);
  } finally {
    setSubscriptionFetch(globalThis.fetch);
  }
});

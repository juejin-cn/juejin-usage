import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptionClient } from './subscription-request.ts';

test('requests a channel and unwraps the local envelope', async () => {
  const calls: string[] = [];
  const read = createSubscriptionClient(true, async input => {
    calls.push(String(input));
    return Response.json({ success: true, message: 'ok', data: { planLabel: 'Plus' } });
  });
  assert.deepEqual(await read('codex'), { planLabel: 'Plus' });
  await read('cursor', { forceRefresh: true });
  assert.deepEqual(calls, ['/functions/tud-subscription/codex', '/functions/tud-subscription/cursor?forceRefresh=1']);
});
test('server mode never calls a local subscription endpoint', async () => {
  const read = createSubscriptionClient(false, async () => { assert.fail('must not fetch'); });
  await assert.rejects(read('codex'), /LOCAL_SUBSCRIPTIONS_UNAVAILABLE/);
});
test('rejects HTTP failures, failed envelopes, null data and malformed responses', async () => {
  for (const response of [
    Response.json({ success: false, message: 'FAILED', data: null }),
    Response.json({ success: true, message: 'FAILED', data: {} }, { status: 500 }),
    Response.json({ success: true, message: 'FAILED', data: null }),
    Response.json({}), new Response('not json'),
  ]) {
    const read = createSubscriptionClient(true, async () => response);
    await assert.rejects(read('codex'));
  }
});
test('preserves Kimi multi-source snapshots', async () => {
  const data = [{ region: 'mainland', status: 'ready' }];
  const read = createSubscriptionClient(true, async () => Response.json({ success: true, message: 'ok', data }));
  assert.deepEqual(await read('kimi'), data);
});

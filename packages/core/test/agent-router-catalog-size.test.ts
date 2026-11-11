import test from 'node:test';
import assert from 'node:assert/strict';
import { zenFreeChannel } from '../src/agent-router/channels/zen-free.js';
import { json } from '../src/agent-router/channels/http.js';

const MiB = 1024 * 1024;
test('Zen accepts a public model catalog larger than 4 MiB and still filters paid, retired and unavailable models', async () => {
  const channel = zenFreeChannel(async url => String(url).endsWith('api.json')
    ? Response.json({ unrelatedProvider: { description: 'x'.repeat(6 * MiB) }, opencode: { npm: '@ai-sdk/openai-compatible', models: {
      free: { name: 'Free', cost: { input: 0, output: 0 } },
      paid: { cost: { input: 1, output: 1 } },
      retired: { cost: { input: 0, output: 0 }, status: 'retired' },
      missing: { cost: { input: 0, output: 0 } },
    } } })
    : Response.json({ data: [{ id: 'free' }, { id: 'paid' }, { id: 'retired' }] }));
  assert.deepEqual(Object.keys(await channel.models({ type: 'oauth', source: 'zen-public' })), ['free']);
});

test('ordinary subscription JSON retains the 4 MiB limit and cancels oversized bodies', async () => {
  let cancelled = false; let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { chunks++; c.enqueue(new Uint8Array(MiB)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(() => json(async () => new Response(body, { headers: { 'content-length': '1' } }), 'https://fixture.example'), /SUBSCRIPTION_RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true); assert.equal(chunks, 5);
});

test('Zen catalog remains bounded and cancels when its own limit is exceeded', async () => {
  let cancelled = false; let chunks = 0;
  const channel = zenFreeChannel(async url => String(url).endsWith('api.json')
    ? new Response(new ReadableStream<Uint8Array>({
      pull(c) { chunks++; c.enqueue(new Uint8Array(MiB)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }))
    : Response.json({ data: [{ id: 'free' }] }));
  await assert.rejects(() => channel.models({ type: 'oauth', source: 'zen-public' }), /SUBSCRIPTION_RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true); assert.equal(chunks, 17);
});

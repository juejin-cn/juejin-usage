import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { AdmissionQueue } from '../src/agent-router/admission.js';
import { RoutingState, responseFailure } from '../src/agent-router/routing.js';
import { prepareReply } from '../src/agent-router/response.js';
import { validateRouterConfig, type AgentRouterConfig, type RouterProvider } from '../src/agent-router/config.js';

const provider = (id: string): RouterProvider => ({ id, name: id, enabled: true, protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['m', 'other'], auth: { kind: 'env', variable: 'KEY' } });
const config = (): AgentRouterConfig => ({ version: 1, port: 0, providers: ['a', 'b', 'c', 'd'].map(provider), groups: [{ id: 'g', members: ['a/m', 'b/m', 'c/m', 'd/m'] }] });
const signal = () => new AbortController().signal;

test('admission holds slots until release, grants FIFO, rejects excess and cleans cancellation', async () => {
  const queue = new AdmissionQueue({ maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 1000 });
  const first = await queue.acquire(signal()); const cancelled = new AbortController();
  const order: number[] = [];
  const second = queue.acquire(cancelled.signal); const rejected = assert.rejects(second, /CANCELLED/);
  const third = queue.acquire(signal()).then(slot => { order.push(3); return slot; });
  await assert.rejects(queue.acquire(signal()), /QUEUE_FULL/);
  cancelled.abort(); await rejected; assert.equal(queue.status().queued, 1);
  const fourth = queue.acquire(signal()).then(slot => { order.push(4); return slot; });
  first.release(); first.release(); const next = await third;
  assert.deepEqual(order, [3]); assert.equal(queue.status().active, 1);
  next.release(); (await fourth).release(); assert.deepEqual(order, [3, 4]);
  assert.equal(queue.status().active, 0); assert.equal(queue.status().queued, 0);
});

test('queue timeout, close and abort during enqueue leave no waiter or slot behind', async () => {
  const queue = new AdmissionQueue({ maxConcurrent: 1, maxQueued: 2, queueTimeoutMs: 5 });
  const held = await queue.acquire(signal());
  await Promise.all([assert.rejects(queue.acquire(signal()), /QUEUE_TIMEOUT/), delay(10)]);
  const abort = new AbortController();
  await assert.rejects(queue.acquire(abort.signal, () => abort.abort()), /CANCELLED/);
  const pending = assert.rejects(queue.acquire(signal()), /DRAINING/); queue.close(); await pending;
  await assert.rejects(queue.acquire(signal()), /DRAINING/); held.release();
  assert.equal(queue.status().active, 0); assert.equal(queue.status().queued, 0);
});

test('planner rotates, caps attempts and records disabled/credential exclusions and protocol conversion', () => {
  const state = new RoutingState(); const input = config(); input.groups[0].strategy = 'round-robin';
  assert.deepEqual(state.plan(input, 'auto/g', 'chat', () => true).candidates.map(c => c.target), ['a/m', 'b/m', 'c/m']);
  assert.deepEqual(state.plan(input, 'auto/g', 'chat', () => true).candidates.map(c => c.target), ['b/m', 'c/m', 'd/m']);
  input.groups[0].strategy = 'ordered'; input.providers[0].enabled = false; input.providers[1].protocol = 'messages';
  const plan = state.plan(input, 'auto/g', 'chat', p => p.id !== 'c');
  assert.deepEqual(plan.decisions.map(d => d.reason), ['disabled', 'ready', 'credential', 'ready']);
  assert.equal(state.plan(input, 'unknown', 'chat', () => true).decisions[0].reason, 'unknown-model');
  assert.equal(JSON.stringify(state.plan(input, 'private-model-or-prompt', 'chat', () => true)).includes('private-model-or-prompt'), false);
});

test('health isolates models, honors Retry-After and permits a single recovery probe', () => {
  let now = 1000; const state = new RoutingState(() => now); const input = config();
  const a = state.plan(input, 'a/m', 'chat', () => true).candidates[0];
  state.failure(a, responseFailure(429, '2', now));
  assert.deepEqual(state.health('a', 'm'), { reason: 'cooldown', retryAt: 3000 });
  assert.equal(state.health('a', 'other').reason, 'ready');
  assert.equal(state.plan(input, 'auto/g', 'chat', () => true).candidates[0].target, 'b/m');
  now = 3000; const probe = state.plan(input, 'a/m', 'chat', () => true).candidates[0];
  assert.equal(state.enter(probe), true); assert.equal(state.enter(probe), false);
  assert.equal(state.plan(input, 'a/m', 'chat', () => true).candidates.length, 0);
  state.failure(probe, responseFailure(503)); state.leave(probe);
  assert.equal(state.health('a', 'm').retryAt, 63000);
  now = 63000; assert.equal(state.enter(probe), true); state.success(probe); state.leave(probe);
  assert.equal(state.health('a', 'm').reason, 'ready');
  assert.equal(responseFailure(429, '999999').retryAfterMs, 300000);
  assert.equal(responseFailure(429, '-1').retryAfterMs, 1000);
  assert.equal(responseFailure(429, new Date(now + 5000).toUTCString(), now).retryAfterMs, 5000);
});

test('authentication blocks a provider; reset ignores stale in-flight failures and probes', () => {
  const state = new RoutingState(); const input = config(); const a = state.plan(input, 'a/m', 'chat', () => true).candidates[0];
  state.failure(a, responseFailure(403)); assert.equal(state.health('a', 'm').reason, 'ready');
  state.failure(a, responseFailure(401)); assert.equal(state.health('a', 'other').reason, 'authentication');
  assert.equal(responseFailure(401).retryable, false); state.reset('a');
  state.failure(a, responseFailure(401)); assert.equal(state.health('a', 'm').reason, 'ready'); assert.equal(state.enter(a), false);
  const fresh = state.plan(input, 'a/m', 'chat', () => true).candidates[0];
  state.failure(fresh, responseFailure(503)); state.leave(a);
  assert.equal(state.health('a', 'm').reason, 'cooldown');
});

test('runtime config remains backward compatible and rejects invalid budgets', () => {
  assert.deepEqual(validateRouterConfig(config()), config());
  for (const gateway of [{ maxConcurrent: 0 }, { maxQueued: -1 }, { maxConcurrent: 32, maxQueued: 32 }, { drainTimeoutMs: 3001 }, { requestTimeoutMs: 1.5 }, { password: 1 }]) {
    assert.throws(() => validateRouterConfig({ ...config(), gateway }));
  }
  assert.throws(() => validateRouterConfig({ ...config(), groups: [{ id: 'g', members: ['a/m'], strategy: 'random' }] }), /INVALID_STRATEGY/);
});

function reply(chunks: string[]) { const body = Readable.from(chunks.map(c => Buffer.from(c))); return { status: 200, headers: { 'content-type': 'text/event-stream' }, body, dispose: () => body.destroy() }; }
test('SSE probe preserves split CRLF/tool bytes, accepts terminal-only streams and rejects early failures', async () => {
  const chunks = [': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r', '\n\r\ndata: {"choices":[{"delta":{"tool_calls":[{"id":"t","function":{"arguments":"{"}}]}}]}\r\n\r\n', 'data: [DONE]\r\n\r\n'];
  let raw = ''; for await (const chunk of await prepareReply(reply(chunks), signal())) raw += chunk;
  assert.equal(raw, chunks.join(''));
  for (const type of ['message_stop', 'response.completed']) {
    const terminal = `data: ${JSON.stringify({ type })}\n\n`; let result = '';
    for await (const chunk of await prepareReply(reply([terminal]), signal())) result += chunk;
    assert.equal(result, terminal);
  }
  await assert.rejects(prepareReply(reply(['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', 'data: {"error":{"type":"rate_limit_error"}}\n\n']), signal()), /HTTP_429/);
  await assert.rejects(prepareReply(reply([': heartbeat\n\n']), signal()), /EMPTY_STREAM/);
  await assert.rejects(prepareReply(reply(['data: ' + 'x'.repeat(256 * 1024)]), signal()), /PREFIX_TOO_LARGE/);
});

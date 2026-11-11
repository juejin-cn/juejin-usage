import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentGateway, RouterCredentials, type RouterProvider, type AgentRouterConfig } from '../src/agent-router/index.js';

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('condition not reached'); await delay(2); }
}
async function mock(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
function p(id: string, baseUrl: string): RouterProvider { return { id, name: id, enabled: true, baseUrl, models: ['m'], protocol: 'chat', auth: { kind: 'env', variable: 'KEY' } }; }
async function gateway(t: TestContext, providers: RouterProvider[], gateway: AgentRouterConfig['gateway'] = {}) {
  const gw = new AgentGateway(new RouterCredentials({ KEY: 'secret' })); t.after(() => gw.stop());
  await gw.start({ version: 1, port: 0, providers, groups: [{ id: 'g', members: providers.map(p => `${p.id}/m`) }], gateway: { drainTimeoutMs: 0, ...gateway } });
  const post = (signal?: AbortSignal) => fetch(gw.status().baseUrl + '/chat/completions', { method: 'POST', signal, headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto/g', stream: true, messages: [{ role: 'user', content: 'never-retain-prompt' }] }) });
  return { gw, post };
}
const wire = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
const wireEnd = 'data: [DONE]\n\n';

test('429 cools a model, skips it on later requests and keeps private content out of trace', async t => {
  let calls = 0; const a = await mock(t, (_req, res) => { calls++; res.writeHead(429, { 'retry-after': '2' }); res.end('vendor-secret'); });
  const b = await mock(t, (_req, res) => res.end('{}')); const { gw, post } = await gateway(t, [p('a', a), p('b', b)]);
  await (await post()).text(); await (await post()).text(); assert.equal(calls, 1);
  const latest = gw.status().requests[0]; assert.equal(latest.decisions?.[0].reason, 'cooldown'); assert.equal(latest.attempts.length, 1);
  assert.equal(JSON.stringify(gw.status()).includes('never-retain-prompt'), false); assert.equal(JSON.stringify(gw.status()).includes('vendor-secret'), false);
});

test('early SSE errors and metadata-only first-response timeout fall back before commit', async t => {
  let mode = 'error'; let closed = 0;
  const a = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'); res.once('close', () => closed++); if (mode === 'error') res.end('data: {"error":{"type":"rate_limit_error"}}\n\n'); });
  const b = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire + wireEnd); });
  const { gw, post } = await gateway(t, [p('a', a), p('b', b)], { firstResponseTimeoutMs: 30 });
  assert.equal(await (await post()).text(), wire + wireEnd); assert.equal(gw.status().requests[0].attempts[0].committed, false);
  gw.resetHealth('a'); mode = 'timeout'; assert.equal(await (await post()).text(), wire + wireEnd);
  assert.equal(gw.status().requests[0].attempts[0].failure, 'first-response'); await until(() => closed === 2);
  assert.equal(gw.status().requests[0].attempts[1].committed, true);
});

test('provider lane owns entire SSE, FIFO cancellation never sends upstream and local rejection does not cool', async t => {
  const held: ServerResponse[] = [];
  const a = await mock(t, (_req, res) => { held.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire); });
  const { gw, post } = await gateway(t, [{ ...p('a', a), limits: { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 1000 } }]);
  const first = await post(); const abort = new AbortController(); const pending = post(abort.signal); const cancelled = assert.rejects(pending);
  await until(() => gw.status().admission.providers[0]?.queued === 1);
  const refused = await post(); assert.equal(refused.status, 429); await refused.text();
  assert.equal(held.length, 1); assert.deepEqual(gw.status().health.models, []);
  abort.abort(); await cancelled; await until(() => gw.status().admission.providers[0].queued === 0);
  const next = post(); await until(() => gw.status().admission.providers[0].queued === 1);
  held[0].end('data: [DONE]\n\n'); await first.text(); const response = await next;
  assert.equal(held.length, 2); held[1].end('data: [DONE]\n\n'); await response.text();
  await until(() => gw.status().active === 0); assert.equal(gw.status().admission.providers[0].active, 0);
});

test('global queue and total deadline are bounded; queue timeout never penalizes provider', async t => {
  const held: ServerResponse[] = [];
  const a = await mock(t, (_req, res) => { held.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire); });
  const { gw, post } = await gateway(t, [p('a', a)], { maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 25, requestTimeoutMs: 500 });
  const first = await post(); const queued = post(); await until(() => gw.status().admission.global.queued === 1);
  const full = await post(); assert.equal(full.status, 429); await full.text();
  const timeout = await queued; assert.equal(timeout.status, 429); assert.match(await timeout.text(), /QUEUE_TIMEOUT/);
  assert.deepEqual(gw.status().health.models, []); held[0].end(wireEnd); await first.text();
  await until(() => gw.status().active === 0);
});

test('total request deadline cancels an already committed stream without fallback', async t => {
  let second = 0; const a = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire); });
  const b = await mock(t, (_req, res) => { second++; res.end('{}'); });
  const { gw, post } = await gateway(t, [p('a', a), p('b', b)], { requestTimeoutMs: 60 });
  const response = await post(); await assert.rejects(response.text()); await until(() => gw.status().active === 0);
  assert.equal(second, 0); assert.equal(gw.status().requests[0].reason, 'REQUEST_TIMEOUT'); assert.deepEqual(gw.status().health.models, []);
});

test('committed SSE failure remains an upstream failure, never client cancellation or fallback', async t => {
  let fail!: () => void; let second = 0;
  const a = await mock(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire); fail = () => res.end('data: {"error":{"type":"overloaded_error"}}\n\n'); });
  const b = await mock(t, (_req, res) => { second++; res.end('{}'); });
  const { gw, post } = await gateway(t, [p('a', a), p('b', b)]);
  const response = await post(); const reading = assert.rejects(response.text()); fail(); await reading;
  await until(() => gw.status().active === 0); const trace = gw.status().requests[0];
  assert.equal(trace.outcome, 'failed'); assert.equal(trace.status, 503); assert.equal(trace.attempts[0].committed, true);
  assert.equal(gw.status().health.models[0].kind, 'unavailable'); assert.equal(second, 0);
});

test('draining revokes queues, lets a short stream finish and cancels a long stream at deadline', async t => {
  const held: ServerResponse[] = [];
  const a = await mock(t, (_req, res) => { held.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire); });
  const { gw, post } = await gateway(t, [{ ...p('a', a), limits: { maxConcurrent: 1 } }], { drainTimeoutMs: 100 });
  const first = await post(); const queued = post(); await until(() => gw.status().admission.providers[0]?.queued === 1);
  const stopping = gw.stop(); await until(() => gw.status().phase === 'draining');
  const denied = await queued; assert.equal(denied.status, 503); await denied.text();
  held[0].end('data: [DONE]\n\n'); await first.text(); await stopping;
  assert.equal(gw.status().phase, 'stopped'); assert.equal(gw.status().active, 0);
  await gw.start({ version: 1, port: 0, providers: [p('a', a)], groups: [{ id: 'g', members: ['a/m'] }], gateway: { drainTimeoutMs: 20 } });
  const long = await post(); const interrupted = assert.rejects(long.text()); await gw.stop(); await interrupted;
  assert.equal(gw.status().active, 0); assert.equal(gw.status().requests[0].reason, 'GATEWAY_DRAIN_TIMEOUT');
});

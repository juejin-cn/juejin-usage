import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentGateway, RouterCredentials, RouterRequestArchive, type RequestArchive, type RouterProvider } from '../src/agent-router/index.js';
import { redactArchive } from '../src/agent-router/request-archive.js';

async function fixture(t: import('node:test').TestContext, handler: RequestListener, fallback = false) {
  const upstream = createServer(handler); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'router-archive-')); const archive = new RouterRequestArchive(dir);
  const records: RequestArchive[] = [];
  const gw = new AgentGateway(new RouterCredentials({ TEST_KEY: 'arbitrary-upstream-credential' }), { onArchive: record => { records.push(record); archive.append(record); } });
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const provider: RouterProvider = { id: 'mock', name: 'mock', enabled: true, protocol: 'chat', baseUrl, models: ['model'], auth: { kind: 'env', variable: 'TEST_KEY' } };
  await gw.start({ version: 1, port: 0, providers: fallback ? [provider, { ...provider, id: 'backup' }] : [provider], groups: fallback ? [{ id: 'fallback', members: ['mock/model', 'backup/model'] }] : [] });
  t.after(async () => { await gw.stop(); await archive.flush(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { gw, archive, dir, records, post: (body: object | string, endpoint = 'chat/completions') => fetch(gw.status().baseUrl + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${gw.token()}`, cookie: 'session=private-cookie' }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    async recorded(count = 1) { for (let i = 0; i < 100 && records.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(records.length, count); await archive.flush(); return records.at(-1)!; } };
}

test('archives converted tool request and exact downstream SSE without exposing credentials', async t => {
  const f = await fixture(t, (req, res) => { req.resume(); req.once('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'vendor-request-42' });
    res.write('data: {"id":"chatcmpl-a","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n');
    res.end('data: {"id":"chatcmpl-a","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
  }); });
  const response = await f.post({ model: 'mock/model', max_tokens: 99, stream: true, messages: [{ role: 'user', content: 'private prompt preserved' }], tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] }, 'messages');
  assert.equal(response.status, 200); const raw = await response.text(); assert.match(raw, /message_stop/);
  const record = await f.recorded(); assert.equal(record.id, response.headers.get('x-agent-router-request-id'));
  assert.equal(record.trace?.outcome, 'completed'); assert.equal(record.trace?.protocol, 'messages');
  assert.equal(record.request.body.text.includes('private prompt preserved'), true);
  const converted = JSON.parse(record.upstream[0].body.text); assert.equal(converted.model, 'model'); assert.equal(converted.tools[0].function.name, 'read_file');
  assert.equal(record.upstream[0].protocol, 'chat'); assert.equal(record.upstream[0].response?.body.text.includes('[DONE]'), true);
  assert.equal((record.upstream[0].response?.headers as Record<string, string>)['x-request-id'], 'vendor-request-42');
  assert.match(record.response.body.text, /message_stop/); assert.equal(record.response.body.incomplete, undefined);
  const stored = await readFile(join(f.dir, record.startedAt.slice(0, 10), record.id + '.json'), 'utf8');
  for (const secret of [f.gw.token(), 'private-cookie', 'arbitrary-upstream-credential']) assert.equal(stored.includes(secret), false);
  assert.equal((await stat(join(f.dir, record.startedAt.slice(0, 10), record.id + '.json'))).mode & 0o777, 0o600);
  const restored = new RouterRequestArchive(f.dir); assert.equal((await restored.list()).requests[0].id, record.id);
  assert.equal((await restored.read(record.startedAt.slice(0, 10), record.id)).trace?.status, 200);
});

test('upstream rejection body and client error are saved with correlation ID', async t => {
  const f = await fixture(t, (req, res) => { req.resume(); req.once('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'unsupported field detail', api_key: 'arbitrary-upstream-credential' } })); }); });
  const response = await f.post({ model: 'mock/model', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(response.status, 400); await response.text();
  const record = await f.recorded(); assert.equal(record.trace?.reason, 'UPSTREAM_HTTP_400');
  assert.equal(record.response.status, 400); assert.match(record.upstream[0].response!.body.text, /unsupported field detail/);
  assert.equal(JSON.stringify(record).includes('arbitrary-upstream-credential'), false); assert.match(record.response.body.text, /UPSTREAM_HTTP_400/);
});

test('invalid JSON is retained as a failed request without an upstream attempt', async t => {
  const f = await fixture(t, (_req, res) => res.end()); const response = await f.post('{broken'); assert.equal(response.status, 400); await response.text();
  const record = await f.recorded(); assert.equal(record.trace?.reason, 'INVALID_JSON'); assert.equal(record.request.body.text, '{broken'); assert.deepEqual(record.upstream, []);
});

test('redacts secret fields in nested objects and common token strings but preserves usage', () => {
  const clean = redactArchive({ messages: [{ content: 'hello' }], access_token: 'secret', usage: { input_tokens: 10 }, nested: { 'x-api-key': 'secret', password: 'secret' }, text: 'Bearer abcd.efgh sk-abcdefghijklmnopqrstuvwxyz' });
  const raw = JSON.stringify(clean); assert.equal(raw.includes('secret'), false); assert.match(raw, /hello/); assert.match(raw, /input_tokens/); assert.equal(raw.includes('abcd.efgh'), false);
});

test('archive rejects traversal, retains newest record under size cap, and paginates equal timestamps', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-retention-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = new RouterRequestArchive(dir, 1);
  const record = (id: string) => ({ version: 1, id, startedAt: '2026-11-07T12:00:00Z', request: { headers: {}, body: { text: 'prompt', bytes: 6, truncated: false } }, response: { headers: {}, body: { text: '', bytes: 0, truncated: false } }, upstream: [], upstreamOmitted: 0 } as RequestArchive);
  const first = randomUUID(), second = randomUUID(); archive.append(record(first)); await archive.flush(); archive.append(record(second)); await archive.flush();
  assert.equal(archive.status().error, null); assert.deepEqual((await archive.list()).requests.map(row => row.id), [second]);
  await assert.rejects(archive.read('../config', second)); await assert.rejects(archive.read('2026-11-07', '../../secret'));
  await assert.rejects(archive.read('2026-11-07', first), /ARCHIVE_NOT_FOUND/);
  const roomy = new RouterRequestArchive(dir);
  for (let i = 0; i < 51; i++) { roomy.append(record(randomUUID())); await roomy.flush(); }
  const page = await roomy.list(); assert.equal(page.requests.length, 50); assert.ok(page.next);
  const rest = await roomy.list(page.next!); assert.equal(rest.requests.length, 2); assert.equal(new Set([...page.requests, ...rest.requests].map(row => row.id)).size, 52);
  await assert.rejects(roomy.list('../bad'));
});


test('keeps every fallback attempt with its rejected body and final successful response', async t => {
  let calls = 0;
  const f = await fixture(t, (req, res) => { req.resume(); req.once('end', () => {
    if (++calls === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"vendor temporarily unavailable"}}'); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"role":"assistant","content":"recovered"},"finish_reason":"stop"}]}'); }
  }); }, true);
  const response = await f.post({ model: 'auto/fallback', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(response.status, 200); await response.text(); const record = await f.recorded();
  assert.equal(record.upstream.length, 2); assert.equal(record.trace?.attempts.length, 2);
  assert.equal(record.upstream[0].response?.status, 503); assert.match(record.upstream[0].response!.body.text, /vendor temporarily unavailable/);
  assert.equal(record.upstream[1].response?.status, 200); assert.match(record.response.body.text, /recovered/);
});

test('saves partial stream on client cancellation without leaving an active request', async t => {
  const f = await fixture(t, (req, res) => { req.resume(); req.once('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
  }); });
  const controller = new AbortController();
  const response = await fetch(f.gw.status().baseUrl + '/chat/completions', { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${f.gw.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock/model', stream: true, messages: [{ role: 'user', content: 'test' }] }) });
  const reader = response.body!.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
  const record = await f.recorded(); assert.equal(record.trace?.outcome, 'cancelled'); assert.equal(record.response.body.incomplete, true); assert.match(record.response.body.text, /partial/); assert.equal(f.gw.status().active, 0);
});

test('body limits mark truncation while the whole model stream still reaches the client', async t => {
  const text = 'x'.repeat(50 * 1024);
  const f = await fixture(t, (req, res) => { req.resume(); req.once('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < 200; i++) res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
    res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }); });
  const response = await f.post({ model: 'mock/model', stream: true, messages: [{ role: 'user', content: 'test' }] }); const raw = await response.text();
  assert.match(raw.slice(-100), /\[DONE\]/); const record = await f.recorded();
  assert.equal(record.trace?.outcome, 'completed'); assert.equal(record.upstream[0].response?.body.truncated, true);
  assert.equal(record.response.body.truncated, true); assert.equal(record.response.body.bytes, Buffer.byteLength(raw));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  AgentGateway, RouterCredentials, discoverLocalLogins, emptyRouterConfig,
  loadRouterConfig, saveRouterConfig, validateRouterConfig, type RouterProvider,
} from '../src/agent-router/index.js';
import { lanAddresses, loopbackAddress, privateIPv4 } from '../src/agent-router/lan.js';

async function mock(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part)); return Buffer.concat(chunks).toString(); }
function provider(id: string, baseUrl: string): RouterProvider {
  return { id, name: id, enabled: true, protocol: 'chat', baseUrl, models: ['native/model'], auth: { kind: 'env', variable: 'TEST_KEY' } };
}
async function gateway(providers: RouterProvider[]) {
  const credentials = new RouterCredentials({ TEST_KEY: 'upstream-secret' });
  const gw = new AgentGateway(credentials);
  await gw.start({ version: 1, port: 0, providers, groups: new Set(providers.map(p => p.protocol)).size === 1 ? [{ id: 'default', members: providers.map(p => `${p.id}/native/model`) }] : [] });
  const base = gw.status().baseUrl!;
  return { gw, base, headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json' }, post: (model = 'auto/default', extra = {}) => fetch(base + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gw.token()}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'private-prompt' }], stream: true }) }) };
}

test('AgentRouter validates and atomically persists only non-secret configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'router-config-')); const path = join(dir, 'router', 'config.json');
  assert.deepEqual(await loadRouterConfig(path), emptyRouterConfig());
  const config = { version: 1, port: 0, providers: [provider('one', 'https://example.com/v1')], groups: [] };
  await saveRouterConfig(path, validateRouterConfig(config));
  assert.deepEqual(await loadRouterConfig(path), config);
  assert.throws(() => validateRouterConfig({ ...config, apiKey: 'do-not-persist' }), /UNKNOWN_FIELD/);
  assert.throws(() => validateRouterConfig({ ...config, providers: [{ ...config.providers[0], baseUrl: 'https://user:secret@example.com' }] }), /INVALID_ENDPOINT/);
  assert.throws(() => validateRouterConfig({ ...config, groups: [{ id: 'bad', members: ['absent/model'] }] }), /INVALID_MEMBERS/);
  assert.doesNotThrow(() => validateRouterConfig({ ...config, providers: [provider('one', 'https://example.com'), { ...provider('two', 'https://example.com'), protocol: 'responses' }], groups: [{ id: 'mixed', members: ['one/native/model', 'two/native/model'] }] }));
  await writeFile(path, '{broken'); await assert.rejects(loadRouterConfig(path), /UNREADABLE/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('gateway isolates control plane, enforces host/token/origin, and strips client credentials', async t => {
  let received: { url?: string; headers?: IncomingMessage['headers']; body?: string } = {};
  const upstream = await mock((req, res) => { void body(req).then(raw => { received = { url: req.url, headers: req.headers, body: raw }; res.end('{"ok":true}'); }); });
  t.after(upstream.close);
  const { gw, base, headers, post } = await gateway([provider('one', upstream.url + '/v1')]); t.after(() => gw.stop());
  assert.equal((await fetch(base + '/models')).status, 401);
  assert.equal((await fetch(base + '/models', { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  const wrongHostStatus = await new Promise(resolve => { const request = httpRequest(base + '/models', { headers: { ...headers, host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.end(); });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(base.replace('/v1', '') + '/functions/tud-agent-router', { headers })).status, 404);
  const models = await (await fetch(base + '/models', { headers })).json() as { data: { id: string }[] };
  assert.deepEqual(models.data.map(m => m.id), ['one/native/model', 'auto/default']);
  const response = await post('one/native/model', { cookie: 'private-cookie', 'x-api-key': 'client-secret', 'x-forwarded-for': '1.2.3.4' });
  assert.equal(response.status, 200); assert.equal(await response.text(), '{"ok":true}');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.headers?.authorization, 'Bearer upstream-secret');
  assert.equal(received.headers?.cookie, undefined); assert.equal(received.headers?.['x-api-key'], undefined);
  assert.equal(JSON.parse(received.body!).model, 'native/model');
  assert.equal(JSON.stringify(gw.status()).includes('private-prompt'), false);
  assert.equal(JSON.stringify(gw.status()).includes('upstream-secret'), false);
  const oldToken = gw.token(); await gw.stop(); await gw.start({ version: 1, port: 0, providers: [], groups: [] });
  assert.notEqual(gw.token(), oldToken);
});

test('LAN sharing is opt-in, private-only, and keeps loopback access', async t => {
  assert.throws(() => validateRouterConfig({ ...emptyRouterConfig(), lan: 'yes' }), /INVALID_CONFIG/);
  assert.equal(validateRouterConfig({ ...emptyRouterConfig(), lan: true }).lan, true);
  for (const address of ['10.0.0.2', '172.16.1.1', '172.31.255.1', '192.168.31.173', '169.254.1.1', '100.64.0.1']) assert.equal(privateIPv4(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '192.169.0.1', 'example.com', '300.1.1.1']) assert.equal(privateIPv4(address), false, address);
  assert.equal(loopbackAddress('::ffff:127.0.0.1'), true); assert.equal(loopbackAddress('192.168.1.2'), false);
  const off = new AgentGateway(new RouterCredentials({}));
  await off.start({ ...emptyRouterConfig(), port: 0 }); t.after(() => off.stop());
  assert.deepEqual(off.status().lanUrls, []);
  const on = new AgentGateway(new RouterCredentials({}));
  await on.start({ ...emptyRouterConfig(), port: 0, lan: true }); t.after(() => on.stop());
  const port = on.status().port;
  assert.deepEqual(on.status().lanUrls, lanAddresses().map(address => `http://${address}:${port}/v1`));
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  const rebound = await new Promise(resolve => { const request = httpRequest(`http://127.0.0.1:${port}/health`, { headers: { host: `evil.example:${port}` } }, response => { response.resume(); resolve(response.statusCode); }); request.end(); });
  assert.equal(rebound, 403);
  for (const address of lanAddresses()) assert.equal((await fetch(`http://${address}:${port}/health`)).status, 200);
});

test('gateway health probe works without a token and preserves inference access controls', async t => {
  const { gw, base } = await gateway([]);
  t.after(() => gw.stop());
  const healthUrl = new URL('/health', base);
  const response = await fetch(healthUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal((await fetch(healthUrl, { method: 'POST' })).status, 404);
  assert.equal((await fetch(healthUrl, { headers: { origin: 'https://evil.example' } })).status, 403);
  const wrongHostStatus = await new Promise(resolve => {
    const request = httpRequest(healthUrl, { headers: { host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.end();
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(base + '/models')).status, 401);
  assert.equal(gw.status().requests.length, 0);
});

test('ordered fallback retries 429 before committing; never retries authentication failures', async t => {
  let firstStatus = 429; let firstCalls = 0; let secondCalls = 0;
  const first = await mock((_req, res) => { firstCalls++; res.writeHead(firstStatus); res.end('secret echoed by vendor'); }); t.after(first.close);
  const second = await mock((_req, res) => { secondCalls++; res.end('{"ok":true}'); }); t.after(second.close);
  const { gw, post } = await gateway([provider('first', first.url), provider('second', second.url)]); t.after(() => gw.stop());
  assert.equal((await post()).status, 200); assert.equal(secondCalls, 1);
  assert.deepEqual(gw.status().requests[0].attempts.map(a => a.status), [429, 200]);
  // A rate-limited model is now skipped until recovery. Reset for this independent auth scenario.
  gw.resetHealth('first'); firstStatus = 401;
  const refused = await post(); assert.equal(refused.status, 401);
  assert.equal((await refused.text()).includes('secret echoed'), false);
  assert.equal(firstCalls, 2); assert.equal(secondCalls, 1);
});

test('SSE reaches client incrementally, preserves tool bytes, and client cancellation stops upstream', async t => {
  let closed!: () => void; const disconnected = new Promise<void>(resolve => { closed = resolve; });
  let secondCalled = false;
  const wire = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"t1","function":{"arguments":"{\\\"x\\\":"}}]}}]}\n\n';
  const first = await mock((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire); res.once('close', closed); }); t.after(first.close);
  const second = await mock((_req, res) => { secondCalled = true; res.end(); }); t.after(second.close);
  const { gw, base, headers } = await gateway([provider('first', first.url), provider('second', second.url)]); t.after(() => gw.stop());
  const abort = new AbortController();
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ model: 'auto/default', stream: true, messages: [] }) });
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), wire);
  abort.abort();
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not cancelled')), 2000).unref())]);
  assert.equal(secondCalled, false);
});

test('native Responses and Anthropic paths preserve protocol and choose one auth header', async t => {
  const seen: Array<{ path?: string; bearer?: string; key?: string | string[]; version?: string | string[] }> = [];
  const upstream = await mock((req, res) => { seen.push({ path: req.url, bearer: req.headers.authorization, key: req.headers['x-api-key'], version: req.headers['anthropic-version'] }); res.end('{}'); }); t.after(upstream.close);
  const providers: RouterProvider[] = [{ ...provider('responses', upstream.url + '/v1'), protocol: 'responses' }, { ...provider('claude-api', upstream.url + '/v1'), protocol: 'messages' }];
  const { gw, base, headers } = await gateway(providers); t.after(() => gw.stop());
  for (const [path, model] of [['responses', 'responses/native/model'], ['messages', 'claude-api/native/model']]) {
    const response = await fetch(base + '/' + path, { method: 'POST', headers, body: JSON.stringify({ model, input: 'hello', messages: [], max_tokens: 10 }) }); assert.equal(response.status, 200); await response.text();
  }
  assert.deepEqual(seen, [{ path: '/v1/responses', bearer: 'Bearer upstream-secret', key: undefined, version: undefined }, { path: '/v1/messages', bearer: undefined, key: 'upstream-secret', version: '2023-06-01' }]);
});

test('OAuth PKCE binds one-time state, exchanges code, single-flights refresh and hides tokens', async t => {
  let now = 1000; let refreshCount = 0; const exchanges: URLSearchParams[] = [];
  const issuer = await mock((req, res) => { void body(req).then(raw => {
    const params = new URLSearchParams(raw); exchanges.push(params);
    if (params.get('grant_type') === 'refresh_token') refreshCount++;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: refreshCount ? 'fresh' : 'access', refresh_token: 'refresh', expires_in: 60, token_type: 'Bearer' }));
  }); }); t.after(issuer.close);
  const p: RouterProvider = { ...provider('oauth', 'https://upstream.example/v1'), auth: { kind: 'oauth', clientId: 'client', authorizeUrl: issuer.url + '/authorize', tokenUrl: issuer.url + '/token', scopes: ['inference'] } };
  const credentials = new RouterCredentials({}, () => now);
  const url = new URL(credentials.begin(p, 'http://127.0.0.1:1234/oauth/callback'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(credentials.complete(new URLSearchParams({ state: 'wrong', code: 'code' })), /STATE_INVALID/);
  const callback = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'code' });
  await credentials.complete(callback); await assert.rejects(credentials.complete(callback), /STATE_INVALID/);
  assert.equal(createHash('sha256').update(exchanges[0].get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(exchanges[0].get('redirect_uri'), 'http://127.0.0.1:1234/oauth/callback');
  assert.equal(await credentials.resolve(p), 'access'); now += 40_000;
  assert.deepEqual(await Promise.all([credentials.resolve(p), credentials.resolve(p), credentials.resolve(p)]), ['fresh', 'fresh', 'fresh']); assert.equal(refreshCount, 1);
  const expired = new URL(credentials.begin(p, 'http://127.0.0.1:1234/oauth/callback')); now += 301_000;
  await assert.rejects(credentials.complete(new URLSearchParams({ state: expired.searchParams.get('state')!, code: 'code' })), /STATE_INVALID/);
  credentials.clear(); assert.equal(credentials.ready(p), false);
});

test('local-login discovery returns metadata without modifying agent stores', async () => {
  const home = await mkdtemp(join(tmpdir(), 'router-home-'));
  await mkdir(join(home, '.codex')); await mkdir(join(home, '.claude'));
  const path = join(home, '.codex', 'auth.json'); const raw = JSON.stringify({ tokens: { access_token: 'private-access', refresh_token: 'private-refresh' } }); await writeFile(path, raw);
  await writeFile(join(home, '.claude', '.credentials.json'), '{broken');
  const statuses = await discoverLocalLogins(home, {});
  assert.deepEqual(statuses, [{ id: 'codex', state: 'detected', inference: false }, { id: 'claude-code', state: 'unreadable', inference: false }]);
  assert.equal(JSON.stringify(statuses).includes('private-'), false); assert.equal(await readFile(path, 'utf8'), raw);
});

test('concurrent starts and stop serialize and release the only inference listener', async () => {
  const gw = new AgentGateway(new RouterCredentials({}));
  const config = { ...emptyRouterConfig(), port: 0 };
  const first = gw.start(config); const duplicate = gw.start(config); const stop = gw.stop();
  await Promise.all([first, duplicate, stop]);
  assert.equal(gw.status().running, false); assert.equal(gw.status().port, 0); assert.equal(gw.token(), '');
});

test('gateway rejects large, invalid and non-JSON requests without contacting upstream', async t => {
  let calls = 0;
  const upstream = await mock((_req, res) => { calls++; res.end('{}'); }); t.after(upstream.close);
  const { gw, base, headers } = await gateway([provider('one', upstream.url)]); t.after(() => gw.stop());
  for (const [raw, contentType, status] of [['{}', 'text/plain', 415], ['{broken', 'application/json', 400], [JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }), 'application/json', 413]] as const) {
    const response = await fetch(base + '/chat/completions', { method: 'POST', headers: { ...headers, 'content-type': contentType }, body: raw });
    assert.equal(response.status, status); await response.text();
  }
  assert.equal(calls, 0);
});

test('OAuth denial consumes state and stopping cancels pending exchange without restoring tokens', async t => {
  let arrived!: () => void; const received = new Promise<void>(resolve => { arrived = resolve; });
  const issuer = await mock((_req, _res) => { arrived(); }); t.after(issuer.close);
  const p: RouterProvider = { ...provider('oauth', 'https://upstream.example/v1'), auth: { kind: 'oauth', clientId: 'client', authorizeUrl: issuer.url + '/authorize', tokenUrl: issuer.url + '/token', scopes: [] } };
  const credentials = new RouterCredentials({});
  const denied = new URL(credentials.begin(p, 'http://127.0.0.1:1234/oauth/callback'));
  const state = denied.searchParams.get('state')!;
  await assert.rejects(credentials.complete(new URLSearchParams({ state, error: 'access_denied' })), /OAUTH_DENIED/);
  await assert.rejects(credentials.complete(new URLSearchParams({ state, code: 'later' })), /STATE_INVALID/);
  const pendingUrl = new URL(credentials.begin(p, 'http://127.0.0.1:1234/oauth/callback'));
  const pending = credentials.complete(new URLSearchParams({ state: pendingUrl.searchParams.get('state')!, code: 'code' }));
  await received; credentials.clear(); await assert.rejects(pending, /OAUTH_EXCHANGE_FAILED/); assert.equal(credentials.ready(p), false);
});

test('broken committed SSE never falls back and stop cancels all active streams', async t => {
  let destroy!: () => void; let secondCalls = 0;
  const first = await mock((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'); destroy = () => res.destroy(); }); t.after(first.close);
  const second = await mock((_req, res) => { secondCalls++; res.end('{}'); }); t.after(second.close);
  const { gw, post } = await gateway([provider('first', first.url), provider('second', second.url)]); t.after(() => gw.stop());
  const response = await post(); const reader = response.body!.getReader(); await reader.read(); destroy();
  await assert.rejects(reader.read()); assert.equal(secondCalls, 0);
  gw.resetHealth('first');
  const next = await post(); const nextReader = next.body!.getReader(); await nextReader.read(); await gw.stop();
  await assert.rejects(nextReader.read()); assert.equal(gw.status().active, 0); assert.equal(gw.status().running, false);
});

test('gateway issues sk-prefixed keys while preserving explicitly restored legacy access tokens', async t => {
  const fresh = new AgentGateway(new RouterCredentials({})); t.after(() => fresh.stop());
  await fresh.start({ version: 1, port: 0, providers: [], groups: [] });
  assert.match(fresh.token(), /^sk-[A-Za-z0-9_-]{43}$/);
  assert.equal((await fetch(fresh.status().baseUrl + '/models', { headers: { authorization: `Bearer ${fresh.token()}` } })).status, 200);
  const legacy = 'a'.repeat(43);
  const restored = new AgentGateway(new RouterCredentials({}), { accessToken: async () => legacy }); t.after(() => restored.stop());
  await restored.start({ version: 1, port: 0, providers: [], groups: [] });
  assert.equal(restored.token(), legacy);
  assert.equal((await fetch(restored.status().baseUrl + '/models', { headers: { authorization: `Bearer ${legacy}` } })).status, 200);
  const next = 'sk-' + 'b'.repeat(43); restored.rotateToken(next);
  assert.equal((await fetch(restored.status().baseUrl + '/models', { headers: { authorization: `Bearer ${legacy}` } })).status, 401);
  assert.equal((await fetch(restored.status().baseUrl + '/models', { headers: { authorization: `Bearer ${next}` } })).status, 200);
});

test('Claude Code Anthropic beta SDK query reaches inference without forwarding arbitrary query parameters', async t => {
  const seen: string[] = [];
  const upstream = await mock((req, res) => {
    seen.push(req.url!);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg-beta', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: 'native/model', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(upstream.close);
  const p: RouterProvider = { ...provider('anthropic', upstream.url + '/v1'), protocol: 'messages' };
  const { gw, base, headers } = await gateway([p]); t.after(() => gw.stop());
  const body = JSON.stringify({ model: 'anthropic/native/model', max_tokens: 8, messages: [{ role: 'user', content: 'Reply OK' }] });
  for (const query of ['', '?beta=true']) {
    const response = await fetch(base + '/messages' + query, { method: 'POST', headers: { ...headers, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-2024-04-04' }, body });
    assert.equal(response.status, 200, query);
    assert.equal((await response.json() as any).content[0].text, 'OK');
  }
  assert.deepEqual(seen, ['/v1/messages', '/v1/messages']);
  for (const route of ['/messages?other=true', '/messages?beta=true&other=true', '/messages?beta=true&beta=true', '/chat/completions?beta=true', '/responses?beta=true']) {
    const response = await fetch(base + route, { method: 'POST', headers, body });
    assert.equal(response.status, 404, route); await response.text();
  }
  const unauthorized = await fetch(base + '/messages?beta=true', { method: 'POST', body });
  assert.equal(unauthorized.status, 401); await unauthorized.text();
  assert.equal(seen.length, 2);
});

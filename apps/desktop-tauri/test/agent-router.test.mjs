import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopAgentRouter } from '../dist/host/agent-router.js';
import { makeRouterPreset } from '@juejin-opensource/jusage-core/agent-router';

test('desktop control requires host key, persists config, and isolates inference lifecycle', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-router-'));
  // These are fake files; this suite never inspects the developer's login store.
  process.env.CODEX_HOME = join(dir, 'codex'); process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  process.env.ROUTER_TEST_KEY = 'supplier-secret'; delete process.env.TUD_AGENT_ROUTER_ENABLED;
  const service = new DesktopAgentRouter(dir, 'native-host-secret', Buffer.alloc(32, 7)); await service.init();
  const admin = createServer((req, res) => { void service.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
  const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'native-host-secret', 'content-type': 'application/json' };
  t.after(async () => { await service.close(); await new Promise(resolve => { admin.close(resolve); admin.closeAllConnections(); }); });
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(base + '/history')).status, 403);
  assert.equal((await fetch(base + '/history?day=invalid', { headers })).status, 400);
  assert.equal((await fetch(base, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base, { headers: { ...headers, 'x-tud-host-key': 'wrong' } })).status, 403);
  const initial = await (await fetch(base, { headers })).json(); assert.equal(initial.data.running, false);
  assert.ok(initial.data.presets.some(p => p.id === 'codex' && p.subscription === 'codex'));
  assert.ok(initial.data.presets.some(p => p.id === 'claude' && p.endpoints.messages));
  const config = { version: 1, port: 0, providers: [{ id: 'one', name: 'test', enabled: true, protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['mock-model'], auth: { kind: 'env', variable: 'ROUTER_TEST_KEY' } }], groups: [] };
  const saved = await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify(config) }); assert.equal(saved.status, 200);
  const path = join(dir, 'agent-router', 'config.json'); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
  assert.equal((await fetch(base + '/start', { method: 'POST', headers })).status, 200);
  const status = (await (await fetch(base, { headers })).json()).data;
  assert.equal(status.running, true); assert.equal(status.providers[0].ready, true);
  assert.equal(JSON.stringify(status).includes('supplier-secret'), false);
  const access = (await (await fetch(base + '/token', { headers })).json()).data.token;
  assert.equal((await fetch(base, { headers: { 'x-tud-host-key': access } })).status, 403);
  assert.equal((await fetch(status.baseUrl + '/models', { headers: { authorization: 'Bearer native-host-secret' } })).status, 401);
  assert.equal((await fetch(status.baseUrl + '/models', { headers: { authorization: `Bearer ${access}` } })).status, 200);
  assert.equal((await fetch(status.baseUrl.replace('/v1', '') + '/functions/tud-agent-router/token', { headers: { authorization: `Bearer ${access}` } })).status, 404);
  assert.equal((await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify(config) })).status, 409);
  assert.equal((await fetch(base + '/routing/reset', { method: 'POST', headers, body: '{"providerId":"one"}' })).status, 200);
  assert.equal((await fetch(base + '/routing/reset', { method: 'POST', headers, body: '{"providerId":"absent"}' })).status, 404);
  assert.equal((await fetch(base + '/routing/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"providerId":"one"}' })).status, 403);
  assert.equal((await fetch(base + '/stop', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/token', { headers })).status, 409);
  const restored = new DesktopAgentRouter(dir, 'other-host', Buffer.alloc(32, 7)); await restored.init();
  assert.equal(restored.gateway.status().running, false); await restored.close();
});

test('malformed router config does not prevent usage host startup or overwrite original', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-router-broken-'));
  await mkdir(join(dir, 'agent-router')); const path = join(dir, 'agent-router', 'config.json'); await writeFile(path, '{broken');
  const service = new DesktopAgentRouter(dir, 'host', Buffer.alloc(32, 7)); t.after(() => service.close());
  await service.init(); assert.equal(service.gateway.status().running, false);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('OAuth control → PKCE callback → inference uses owned token, then stop revokes session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-router-oauth-'));
  let upstreamAuth;
  const upstream = createServer((req, res) => {
    if (req.url === '/token') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'fake-oauth-access', token_type: 'Bearer', expires_in: 3600 }));
    } else {
      upstreamAuth = req.headers.authorization; res.setHeader('content-type', 'application/json'); res.end('{"choices":[]}');
    }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const issuer = `http://127.0.0.1:${upstream.address().port}`;
  const config = { version: 1, port: 0, providers: [{ id: 'oauth', name: 'Fake OAuth', enabled: true, protocol: 'chat', baseUrl: issuer + '/v1', models: ['fake-model'], auth: { kind: 'oauth', clientId: 'test-client', authorizeUrl: issuer + '/authorize', tokenUrl: issuer + '/token', scopes: ['inference'] } }], groups: [] };
  await mkdir(join(dir, 'agent-router')); await writeFile(join(dir, 'agent-router', 'config.json'), JSON.stringify(config));
  const service = new DesktopAgentRouter(dir, 'oauth-admin', Buffer.alloc(32, 7)); await service.init();
  const admin = createServer((req, res) => { void service.handle(req, res); });
  admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
  t.after(async () => { await service.close(); await Promise.all([admin, upstream].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); });
  const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'oauth-admin', 'content-type': 'application/json' };
  await fetch(base + '/start', { method: 'POST', headers });
  const flow = (await (await fetch(base + '/oauth/start', { method: 'POST', headers, body: '{"providerId":"oauth"}' })).json()).data;
  const authorization = new URL(flow.url); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'fake-code');
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await fetch(callback)).status, 400);
  const snapshot = (await (await fetch(base, { headers })).json()).data;
  assert.equal(snapshot.providers[0].ready, true); assert.equal(JSON.stringify(snapshot).includes('fake-oauth-access'), false);
  const token = (await (await fetch(base + '/token', { headers })).json()).data.token;
  const inferred = await fetch(snapshot.baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'oauth/fake-model', messages: [] }) });
  assert.equal(inferred.status, 200); await inferred.text(); assert.equal(upstreamAuth, 'Bearer fake-oauth-access');
  const days = (await (await fetch(base + '/history', { headers })).json()).data.dates;
  const archived = (await (await fetch(base + '/history?day=' + days[0], { headers })).json()).data;
  assert.equal(archived.requests[0].outcome, 'completed');
  const delta = await (await fetch(base + '/history?day=' + days[0] + '&after=' + archived.cursor, { headers })).json();
  assert.deepEqual(delta.data.requests, []); assert.equal(delta.data.reset, false);
  assert.equal((await fetch(base + '/history?day=' + days[0] + '&after=' + archived.cursor + '&before=2', { headers })).status, 400);
  assert.equal((await fetch(base + '/history?after=' + archived.cursor, { headers })).status, 400);
  assert.equal(JSON.stringify(archived).includes('fake-oauth-access'), false);
  await fetch(base + '/stop', { method: 'POST', headers });
  assert.equal(service.gateway.credentials.ready(config.providers[0]), true); // Stopping preserves owned login credentials.
  assert.equal((await readFile(join(dir, 'agent-router', 'config.json'), 'utf8')).includes('fake-oauth-access'), false);
});

test('subscription login requires running gateway but quota queries work while stopped without exporting secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-router-subscription-'));

  const service = new DesktopAgentRouter(dir, 'subscription-admin', Buffer.alloc(32, 7)); await service.init();
  const admin = createServer((req, res) => { void service.handle(req, res); }); admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
  t.after(async () => { await service.close(); await new Promise(resolve => { admin.close(resolve); admin.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'subscription-admin', 'content-type': 'application/json' };
  const p = makeRouterPreset('codex', 'responses');
  const saved = await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify({ version: 1, port: 0, providers: [p], groups: [] }) }); assert.equal(saved.status, 200);
  const body = JSON.stringify({ providerId: p.id });
  service.gateway.credentials.subscriptions.usage = async () => ({ state: 'unknown', windows: [] });
  service.gateway.credentials.subscriptions.begin = async () => ({ url: 'https://auth.openai.com/authorize' });
  assert.equal((await fetch(base + '/subscription/login', { method: 'POST', headers, body })).status, 409);
  const stoppedUsage = await fetch(base + '/subscription/usage', { method: 'POST', headers, body });
  assert.equal(stoppedUsage.status, 200);
  assert.equal((await stoppedUsage.json()).data.state, 'unknown');
  assert.equal(service.gateway.status().running, false);
  const disabled = await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify({ version: 1, port: 0, providers: [{ ...p, enabled: false }], groups: [] }) });
  assert.equal(disabled.status, 200);
  assert.equal((await fetch(base + '/subscription/usage', { method: 'POST', headers, body })).status, 200);
  await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify({ version: 1, port: 0, providers: [p], groups: [] }) });
  await fetch(base + '/start', { method: 'POST', headers });
  // The host contract is isolated from real OAuth; native workers have their own tests.
  const login = await (await fetch(base + '/subscription/login', { method: 'POST', headers, body })).json(); assert.deepEqual(login.data, { url: 'https://auth.openai.com/authorize' });
  const snapshot = await (await fetch(base, { headers })).json(); assert.equal(snapshot.data.providers[0].subscription.phase, 'signed-out');
  const usage = await (await fetch(base + '/subscription/usage', { method: 'POST', headers, body })).json();
  assert.equal(usage.data.state, 'unknown'); assert.deepEqual(usage.data.windows, []);
  assert.equal((await fetch(base + '/subscription/usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403);
  assert.equal(JSON.stringify(snapshot).includes('fake-account-secret'), false);
  assert.equal((await readFile(join(dir, 'agent-router', 'config.json'), 'utf8')).includes('fake-account-secret'), false);
  assert.equal((await fetch(base + '/subscription/cancel', { method: 'POST', body, headers })).status, 200);
  assert.equal((await fetch(base + '/subscription/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403);
});

test('card lifecycle keeps stopped state on occupied port and releases listener on stop', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-card-'));
  const blocker = createServer(); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = blocker.address().port;
  const service = new DesktopAgentRouter(dir, 'card-host-key', Buffer.alloc(32, 7)); await service.init();
  const admin = createServer((req, res) => { void service.handle(req, res); });
  admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
  t.after(async () => {
    await service.close();
    await new Promise(resolve => { admin.close(resolve); admin.closeAllConnections(); });
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
  });
  const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'card-host-key', 'content-type': 'application/json' };
  const initial = (await (await fetch(base, { headers })).json()).data;
  assert.match(String(initial.config.port), /^\d{5}$/);
  const config = { ...initial.config, port };
  assert.equal((await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify(config) })).status, 200);
  assert.equal((await fetch(base + '/start', { method: 'POST', headers })).status, 500);
  assert.equal(service.gateway.status().running, false);
  await new Promise(resolve => blocker.close(resolve));
  assert.equal((await fetch(base + '/start', { method: 'POST', headers })).status, 200);
  assert.equal(service.gateway.status().port, port);
  const token = service.gateway.token();
  const appended = { ...config, providers: [{ id: 'new-tool', name: 'New tool', enabled: true, protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['test-model'], auth: { kind: 'env', variable: 'ROUTER_TEST_KEY' } }] };
  assert.equal((await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify(appended) })).status, 200);
  assert.equal(service.gateway.token(), token, 'adding a tool must preserve client access tokens');
  const changed = { ...appended, providers: [{ ...appended.providers[0], baseUrl: 'https://other.example/v1' }] };
  assert.equal((await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify(changed) })).status, 409);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'agent-router', 'config.json'), 'utf8')), appended);
  const updatedModels = { ...appended, providers: [{ ...appended.providers[0], models: ['test-model', 'another-model'] }] };
  assert.equal((await fetch(base + '/config', { method: 'PUT', headers, body: JSON.stringify(updatedModels) })).status, 200);
  assert.equal(service.gateway.token(), token, 'changing selected models must preserve client access tokens');
  const address = service.gateway.status().baseUrl;
  const catalog = await (await fetch(address + '/models', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.ok(catalog.data.some(model => model.id === 'new-tool/test-model'));
  assert.ok(catalog.data.some(model => model.id === 'new-tool/another-model'));

  assert.equal((await fetch(base + '/stop', { method: 'POST', headers })).status, 200);
  assert.equal(service.gateway.status().phase, 'stopped');
  const reclaimed = createServer(); reclaimed.listen(port, '127.0.0.1'); await once(reclaimed, 'listening');
  await new Promise(resolve => reclaimed.close(resolve));
  // The refresh action must reopen the same listener and preserve client configuration.
  assert.equal((await fetch(base + '/start', { method: 'POST', headers })).status, 200);
  assert.equal(service.gateway.status().port, port);
  assert.equal(service.gateway.token(), token, 'restarting must preserve the client access token');
  const restarted = (await (await fetch(base, { headers })).json()).data;
  assert.deepEqual(restarted.config.providers, updatedModels.providers);
  assert.equal((await fetch(address + '/models', { headers: { authorization: `Bearer ${token}` } })).status, 200);
});

test('model preview queries official catalog without saving draft config or exposing credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-model-preview-'));
  process.env.MODEL_PREVIEW_TEST_KEY = 'preview-secret';
  const upstream = createServer((req, res) => {
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers['x-api-key'], 'preview-secret');
    res.end(JSON.stringify({ data: [{ id: 'official-model-a' }, { id: 'official-model-b' }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const service = new DesktopAgentRouter(dir, 'preview-host-key', Buffer.alloc(32, 7)); await service.init();
  const admin = createServer((req, res) => { void service.handle(req, res); });
  admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
  t.after(async () => {
    await service.close(); delete process.env.MODEL_PREVIEW_TEST_KEY;
    await Promise.all([admin, upstream].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  });
  const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'preview-host-key', 'content-type': 'application/json' };
  const provider = { id: 'preview', name: 'Preview', enabled: true, protocol: 'messages', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['placeholder'], auth: { kind: 'env', variable: 'MODEL_PREVIEW_TEST_KEY' } };
  assert.equal((await fetch(base + '/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }) })).status, 403);
  const result = await (await fetch(base + '/models', { method: 'POST', headers, body: JSON.stringify({ provider }) })).json();
  assert.deepEqual(result.data.models, ['official-model-a', 'official-model-b']);
  assert.equal(JSON.stringify(result).includes('preview-secret'), false);
  const snapshot = (await (await fetch(base, { headers })).json()).data;
  assert.equal(snapshot.running, false); assert.deepEqual(snapshot.config.providers, []);
  await assert.rejects(readFile(join(dir, 'agent-router', 'config.json')), { code: 'ENOENT' });
  const subscription = makeRouterPreset('codex', 'responses');
  assert.equal((await fetch(base + '/models', { method: 'POST', headers, body: JSON.stringify({ provider: subscription }) })).status, 409);
});

test('encrypted login and gateway token restore across service instances; logout and rotation revoke access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-persistent-'));
  const key = Buffer.alloc(32, 29);
  await mkdir(join(dir, 'agent-router'));
  const provider = { id: 'persist', name: 'Persist', enabled: true, protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['test-model'], auth: { kind: 'env', variable: 'NO_REAL_KEY_FOR_PERSISTENCE_TEST' } };
  await writeFile(join(dir, 'agent-router', 'config.json'), JSON.stringify({ version: 1, port: 0, providers: [provider], groups: [] }));
  async function open() {
    const service = new DesktopAgentRouter(dir, 'persistence-host', key); await service.init();
    const admin = createServer((req, res) => { void service.handle(req, res); }); admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
    const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
    const call = async (path = '', value) => {
      const response = await fetch(base + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'x-tud-host-key': 'persistence-host', 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      assert.equal(response.status, 200); return (await response.json()).data;
    };
    const close = async () => { await service.close(); await new Promise(resolve => { admin.close(resolve); admin.closeAllConnections(); }); };
    t.after(close); return { service, call, close };
  }
  const first = await open();
  await first.call('/credentials/import', { providerId: provider.id, key: 'private-api-key-for-test' });
  await first.call('/start', {}); const token = (await first.call('/token')).token;
  const firstState = await first.call(); assert.equal(firstState.providers[0].saved, true);
  assert.equal(JSON.stringify(firstState).includes('private-api-key-for-test'), false);
  await first.close();
  const second = await open(); assert.equal((await second.call()).providers[0].ready, true);
  await second.call('/start', {}); assert.equal((await second.call('/token')).token, token);
  await second.call('/token/rotate', {}); const rotated = (await second.call('/token')).token; assert.notEqual(rotated, token); assert.match(rotated, /^sk-[A-Za-z0-9_-]{43}$/);
  const address = second.service.gateway.status().baseUrl;
  assert.equal((await fetch(address + '/models', { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await fetch(address + '/models', { headers: { authorization: `Bearer ${rotated}` } })).status, 200);
  await second.call('/credentials/logout', { providerId: provider.id }); assert.equal((await second.call()).providers[0].ready, false);
  const encrypted = await readFile(join(dir, 'agent-router', 'credentials.enc'), 'utf8');
  assert.equal(encrypted.includes('private-api-key-for-test'), false); assert.equal(encrypted.includes(rotated), false);
  await second.close(); const third = await open(); assert.equal((await third.call()).providers[0].saved, false);
});

for (const running of [false, true]) test(`duplicate OAuth account is ignored while gateway is ${running ? 'running' : 'stopped'}`, async t => {
  const { RouterCredentialStore } = await import('@juejin-opensource/jusage-core/agent-router');
  const dir = await mkdtemp(join(tmpdir(), 'gateway-duplicate-'));
  const key = Buffer.alloc(32, 9);
  const original = { ...makeRouterPreset('codex', 'responses'), id: 'original', models: ['auto'], excludedModels: ['auto'] };
  const duplicate = { ...original, id: 'duplicate', excludedModels: [] };
  const different = { ...original, id: 'different' };
  const config = { version: 1, port: 0, providers: [original, duplicate, different], groups: [] };
  await mkdir(join(dir, 'agent-router'));
  await writeFile(join(dir, 'agent-router', 'config.json'), JSON.stringify(config));
  const store = new RouterCredentialStore(join(dir, 'agent-router', 'credentials.enc'), key);
  await store.init();
  for (const provider of config.providers) await store.set(provider, { kind: 'subscription', auth: {
    type: 'oauth', access: 'fake-token-' + provider.id, accountId: provider.id === 'different' ? 'other-user' : 'same-user', accountName: 'same-name',
  } });
  const service = new DesktopAgentRouter(dir, 'duplicate-host', key); await service.init();
  const admin = createServer((req, res) => { void service.handle(req, res); });
  admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
  t.after(async () => { await service.close(); await new Promise(resolve => { admin.close(resolve); admin.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'duplicate-host', 'content-type': 'application/json' };
  if (running) assert.equal((await fetch(base + '/start', { method: 'POST', headers })).status, 200);
  const token = service.gateway.token();
  const deduplicate = id => fetch(base + '/subscription/deduplicate', { method: 'POST', headers, body: JSON.stringify({ providerId: id }) });
  const response = await deduplicate('duplicate'); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { duplicate: true, providerId: 'original' });
  const snapshot = (await (await fetch(base, { headers })).json()).data;
  assert.deepEqual(snapshot.config.providers, [original, different]);
  assert.equal(service.gateway.status().running, running);
  assert.equal(service.gateway.token(), token);
  assert.deepEqual((await (await deduplicate('different')).json()).data, { duplicate: false, providerId: 'different' });
  assert.deepEqual((await (await deduplicate('original')).json()).data, { duplicate: false, providerId: 'original' });
  const persisted = new RouterCredentialStore(join(dir, 'agent-router', 'credentials.enc'), key); await persisted.init();
  assert.ok(persisted.get(original)); assert.equal(persisted.get(duplicate), undefined);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'agent-router', 'config.json'), 'utf8')).providers, [original, different]);
});

for (const running of [false, true]) test(`account removal clears credentials and route members while ${running ? 'running' : 'stopped'}`, async t => {
  const { RouterCredentialStore } = await import('@juejin-opensource/jusage-core/agent-router');
  const dir = await mkdtemp(join(tmpdir(), 'gateway-remove-')); const key = Buffer.alloc(32, 11);
  const first = { ...makeRouterPreset('codex', 'responses'), id: 'first', models: ['auto'] };
  const second = { ...first, id: 'second' };
  const config = { version: 1, port: 0, providers: [first, second], groups: [
    { id: 'shared', members: ['first/auto', 'second/auto'] }, { id: 'only-first', members: ['first/auto'] },
  ] };
  await mkdir(join(dir, 'agent-router')); await writeFile(join(dir, 'agent-router', 'config.json'), JSON.stringify(config));
  const store = new RouterCredentialStore(join(dir, 'agent-router', 'credentials.enc'), key); await store.init();
  for (const provider of config.providers) await store.set(provider, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-' + provider.id, uid: provider.id } });
  const service = new DesktopAgentRouter(dir, 'remove-host', key); await service.init();
  const admin = createServer((req, res) => { void service.handle(req, res); });
  admin.listen(0, '127.0.0.1'); await once(admin, 'listening');
  t.after(async () => { await service.close(); await new Promise(resolve => { admin.close(resolve); admin.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${admin.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'remove-host', 'content-type': 'application/json' };
  if (running) await fetch(base + '/start', { method: 'POST', headers });
  const token = service.gateway.token();
  assert.equal((await fetch(base + '/providers/remove', { method: 'POST', body: JSON.stringify({ providerId: 'first' }) })).status, 403);
  const remove = providerId => fetch(base + '/providers/remove', { method: 'POST', headers, body: JSON.stringify({ providerId }) });
  assert.equal((await remove('missing')).status, 404);
  assert.equal((await remove('first')).status, 200);
  const snapshot = (await (await fetch(base, { headers })).json()).data;
  assert.deepEqual(snapshot.config.providers, [second]);
  assert.deepEqual(snapshot.config.groups, [{ id: 'shared', members: ['second/auto'] }]);
  const restored = new RouterCredentialStore(join(dir, 'agent-router', 'credentials.enc'), key); await restored.init();
  assert.equal(restored.get(first), undefined); assert.ok(restored.get(second));
  assert.equal(service.gateway.status().running, running); assert.equal(service.gateway.token(), token);
  if (running) {
    const catalog = await (await fetch(service.gateway.status().baseUrl + '/models', { headers: { authorization: `Bearer ${token}` } })).json();
    assert.ok(!catalog.data.some(model => model.id.startsWith('first/')));
    assert.ok(catalog.data.some(model => model.id === 'second/auto'));
  }
  assert.equal((await remove('second')).status, 200);
  const persisted = JSON.parse(await readFile(join(dir, 'agent-router', 'config.json'), 'utf8'));
  assert.deepEqual(persisted.providers, []); assert.deepEqual(persisted.groups, []);
});

test('tool integrations are host-key guarded, reversible and follow gateway token/model changes', async t => {
  const { realpath } = await import('node:fs/promises');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'integration-host-')));
  const home = join(dir, 'home'); const configFile = join(home, '.config', 'opencode', 'opencode.json');
  await mkdir(join(home, '.config', 'opencode'), { recursive: true }); await writeFile(configFile, '{"theme":"system"}');
  process.env.INTEGRATION_TEST_KEY = 'upstream-fixture'; t.after(() => delete process.env.INTEGRATION_TEST_KEY);
  const host = new DesktopAgentRouter(dir, 'host-secret', Buffer.alloc(32, 31), { home, platform: 'darwin', env: { PATH: '' }, dataDir: join(dir, 'managed') });
  await host.init(); t.after(() => host.close());
  const server = createServer((req, res) => void host.handle(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/functions/tud-agent-router`;
  const headers = { 'x-tud-host-key': 'host-secret', 'content-type': 'application/json' };
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  };
  assert.equal((await fetch(base + '/agents/integrations')).status, 403);
  assert.equal((await fetch(base + '/agents/integrations', { headers: { ...headers, origin: 'https://other.test' } })).status, 403);
  const config = { version: 1, port: 0, providers: [{ id: 'one', name: 'Provider', enabled: true, protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['a', 'b'], excludedModels: ['b'], auth: { kind: 'env', variable: 'INTEGRATION_TEST_KEY' } }], groups: [] };
  await call('/config', 'PUT', config); await call('/start', 'POST');
  let state = await call('/agents/integrations'); assert.equal(state.tools.length, 7); assert.deepEqual(state.models.map(m => m.id), ['one/a']);
  state = await call('/agents/integrations/opencode', 'PUT', { mode: 'all', models: [], defaultModel: 'one/a' });
  assert.equal(state.tools[0].enabled, true);
  let file = JSON.parse(await readFile(configFile, 'utf8')); const oldKey = file.provider.jusage.options.apiKey;
  assert.equal(file.model, 'jusage/one/a'); assert.equal(file.theme, 'system'); assert.equal(JSON.stringify(state).includes(oldKey), false);
  await call('/token/rotate', 'POST'); file = JSON.parse(await readFile(configFile, 'utf8')); assert.notEqual(file.provider.jusage.options.apiKey, oldKey);
  await call('/stop', 'POST'); state = await call('/agents/integrations'); assert.equal(state.tools[0].state, 'stopped');
  await call('/agents/integrations/opencode', 'DELETE'); assert.equal(await readFile(configFile, 'utf8'), '{"theme":"system"}');
  const manual = await fetch(base + '/agents/integrations/cursor-cli', { method: 'PUT', headers, body: JSON.stringify({ mode: 'all', models: [], defaultModel: 'one/a' }) }); assert.equal(manual.status, 409);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterCredentialStore, RouterSubscriptions, makeRouterPreset, validateRouterConfig } from '../src/agent-router/index.js';
import { nativeAuthHeaders, normalizeGlmReply, glmErrorStatus } from '../src/agent-router/glm.js';

test('GLM normalizes small HTTP-200 refusal envelopes and preserves large success bodies', async t => {
  assert.equal(glmErrorStatus({ success: false, code: 1000 }), 401); assert.equal(glmErrorStatus({ success: false, code: 1113 }), 429);
  assert.equal(glmErrorStatus({ choices: [] }), null);
  assert.equal(glmErrorStatus({ success: false, code: 1210 }), 400); assert.equal(glmErrorStatus({ success: false, code: 1220 }), 403);
  let raw = '{"success":false,"code":1000,"msg":"do-not-echo-token"}';
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(raw); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const first = await new Promise<import('node:http').IncomingMessage>(resolve => { get(url, resolve); }); const rejected = await normalizeGlmReply(first); assert.equal(rejected.status, 401);
  raw = JSON.stringify({ choices: [], padding: 'x'.repeat(128000) });
  const second = await new Promise<import('node:http').IncomingMessage>(resolve => { get(url, resolve); }); const success = await normalizeGlmReply(second);
  const chunks: Buffer[] = []; for await (const part of success.stream) chunks.push(Buffer.from(part)); assert.equal(Buffer.concat(chunks).toString(), raw);
});


test('API presets retain pinned endpoints and reject unsupported subscription methods', () => {
  for (const id of ['glm-cn-coding', 'glm-global-coding', 'glm-cn-api', 'glm-global-api']) {
    const p = makeRouterPreset(id);
    assert.doesNotThrow(() => validateRouterConfig({ version: 1, port: 0, providers: [p], groups: [] }));
    assert.throws(() => validateRouterConfig({ version: 1, port: 0, providers: [{ ...p, baseUrl: 'https://evil.example' }], groups: [] }));
  }
  assert.deepEqual(nativeAuthHeaders(makeRouterPreset('glm-cn-coding', 'messages'), 'fake-key'), { authorization: 'Bearer fake-key', 'anthropic-version': '2023-06-01' });
  const p = makeRouterPreset('codex', 'responses');
  assert.throws(() => validateRouterConfig({ version: 1, port: 0, providers: [{ ...p, auth: { ...p.auth, method: 'desktop' } }], groups: [] }), /INVALID_SUBSCRIPTION/);
});

test('native worker refreshes credentials, reads models/usage, streams, cancels and reports expired login', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jusage-worker-'));
  const store = new RouterCredentialStore(join(root, 'credentials.enc'), Buffer.alloc(32, 17)); await store.init();
  const p = makeRouterPreset('codex', 'responses');
  await store.set(p, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-old', refresh: 'fake-refresh', expires: 1, accountId: 'account-1', accountName: 'Alice' } });
  const manager = new RouterSubscriptions({}, new URL('./fixtures/agent-router-worker.js', import.meta.url), store);
  t.after(() => manager.close());
  const catalogs = await Promise.all([manager.models(p), manager.models(p), manager.models(p)]);
  assert.ok(catalogs.every(models => models.includes('gpt-test')));
  const catalog = await manager.modelCatalog(p);
  assert.equal(catalog.metadata?.['gpt-test'].capabilities?.vision, true);
  assert.equal(catalog.metadata?.['gpt-test'].limits?.contextTokens, 272000);
  assert.equal(catalog.metadata?.['gpt-test'].limits?.maxContextTokens, 1000000);
  assert.ok(catalog.checkedAt);
  assert.ok(!JSON.stringify(catalog).includes('fake-'));
  const details = await Promise.all([manager.usage(p), manager.usage(p), manager.usage(p)]);
  assert.ok(details.every(info => info.windows[0]?.percent === 25 && info.accountName === 'Alice' && info.accountId === 'account-1'));
  const response = await manager.fetch(p, { model: 'gpt-test', input: 'hi', stream: false }, new AbortController().signal);
  assert.equal((await response.json() as { id: string }).id, 'response-test');
  const abort = new AbortController();
  const held = await manager.fetch(p, { model: 'hold', stream: true }, abort.signal);
  const reader = held.body!.getReader(); assert.equal((await reader.read()).done, false);
  abort.abort(); await assert.rejects(reader.read(), /CANCELLED/);
  const expired = await manager.fetch(p, { model: 'expired', stream: true }, new AbortController().signal);
  assert.equal(expired.status, 401); await expired.text();
  assert.equal(manager.state(p).error, 'SUBSCRIPTION_LOGIN_REQUIRED');
  assert.equal(JSON.stringify(manager.state(p)).includes('fake-'), false);
});

test('restored Chat subscription crosses the real worker boundary and quota falls back to existing Codex', async t => {
  const { AgentGateway, RouterCredentials } = await import('../src/agent-router/index.js');
  const root = await mkdtemp(join(tmpdir(), 'jusage-worker-chat-'));
  const store = new RouterCredentialStore(join(root, 'credentials.enc'), Buffer.alloc(32, 23)); await store.init();
  const copilot = { ...makeRouterPreset('github-copilot', 'chat'), models: ['limited', 'chat-test'] };
  const codex = { ...makeRouterPreset('codex', 'responses'), models: ['gpt-test'] };
  for (const p of [copilot, codex]) await store.set(p, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 3600000 } });
  const manager = new RouterSubscriptions({}, new URL('./fixtures/agent-router-worker.js', import.meta.url), store); t.after(() => manager.close());
  assert.deepEqual(await manager.models(copilot), ['chat-test']);
  const direct = await manager.fetch(copilot, { model: 'chat-test', messages: [{ role: 'user', content: 'hello' }] }, new AbortController().signal);
  assert.equal((await direct.json() as any).choices[0].message.content, 'native chat');
  const gateway = new AgentGateway(new RouterCredentials({}, Date.now, manager, store)); t.after(() => gateway.stop());
  await gateway.start({ version: 1, port: 0, providers: [copilot, codex], groups: [{ id: 'fallback', members: [`${copilot.id}/limited`, `${codex.id}/gpt-test`] }] });
  const result = await fetch(gateway.status().baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gateway.token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'auto/fallback', messages: [{ role: 'user', content: 'hello' }], stream: false }) });
  assert.equal(result.status, 200); assert.equal((await result.json() as any).object, 'chat.completion');
});


test('model metadata keeps account-specific multipliers separate across real workers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jusage-model-accounts-'));
  const store = new RouterCredentialStore(join(root, 'credentials.enc'), Buffer.alloc(32, 25)); await store.init();
  const first = { ...makeRouterPreset('github-copilot', 'chat'), id: 'copilot-first' };
  const second = { ...first, id: 'copilot-second' };
  await store.set(first, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-first', refresh: 'fake-first-refresh', expires: Date.now() + 3600000 } });
  await store.set(second, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-second', refresh: 'fake-second-refresh', expires: Date.now() + 3600000 } });
  const manager = new RouterSubscriptions({}, new URL('./fixtures/agent-router-worker.js', import.meta.url), store);
  t.after(() => manager.close());
  const catalogs = await Promise.all([manager.modelCatalog(first), manager.modelCatalog(second)]);
  assert.equal(catalogs[0].metadata?.['chat-test'].billing?.multiplier, 1);
  assert.equal(catalogs[1].metadata?.['chat-test'].billing?.multiplier, 0.5);
});

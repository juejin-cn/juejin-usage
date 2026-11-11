import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AgentGateway, RouterCredentials, loadRouterConfig, validateRouterConfig, withoutRouterProvider, publicModelId, resolveModelId, type RouterProvider } from '../src/agent-router/index.js';
import { credentialIdentity } from '../src/agent-router/credential-store.js';

const first = 'relay-11111111-1111-4111-8111-111111111111';
const second = 'relay-22222222-2222-4222-8222-222222222222';
const provider = (id = first): RouterProvider => ({ id, name: 'Relay', enabled: true, protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['claude-sonnet-4-6', 'hidden'], excludedModels: ['hidden'], auth: { kind: 'env', variable: id === first ? 'KEY_A' : 'KEY_B' } });
const config = (providers: RouterProvider[]) => ({ version: 1 as const, port: 0, providers, groups: [] });

test('short provider aliases are deterministic, avoid canonical namespaces and keep credentials bound to the original ID', () => {
  const result = validateRouterConfig(config([provider(second), provider()]));
  assert.equal(result.providers[0].alias, 'relay-2'); assert.equal(result.providers[1].alias, 'relay');
  const original = provider(); const aliased = result.providers[1];
  assert.equal(credentialIdentity(original), credentialIdentity(aliased));
  assert.equal(publicModelId(aliased, 'claude-sonnet-4-6'), 'relay/claude-sonnet-4-6');
  assert.equal(resolveModelId(result, 'relay/claude-sonnet-4-6'), first + '/claude-sonnet-4-6');
  assert.equal(resolveModelId(result, first + '/claude-sonnet-4-6'), first + '/claude-sonnet-4-6');
  assert.equal(resolveModelId(result, 'relay/hidden'), undefined);
  const remaining = withoutRouterProvider(result, first);
  assert.equal(remaining.providers[0].alias, 'relay-2');
  assert.equal(resolveModelId(remaining, 'relay/claude-sonnet-4-6'), undefined);
  const reserved = validateRouterConfig(config([provider('relay'), provider()]));
  assert.equal(reserved.providers[1].alias, 'relay-2');
});

test('explicit aliases cannot collide with another alias, canonical namespace or the group namespace', () => {
  for (const providers of [
    [{ ...provider(), alias: 'same' }, { ...provider(second), alias: 'same' }],
    [{ ...provider(), alias: second }, provider(second)],
    [{ ...provider(), alias: 'auto' }],
  ]) assert.throws(() => validateRouterConfig(config(providers)), /DUPLICATE_PROVIDER_ALIAS/);
});

test('first alias allocation is saved with an exact backup and survives reload, reorder, removal and adding accounts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-aliases-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json'); const raw = JSON.stringify(config([provider(second), provider()]), null, 2) + '\n';
  await writeFile(file, raw);
  const loaded = await loadRouterConfig(file);
  assert.equal(await readFile(file + '.before-model-aliases.bak', 'utf8'), raw);
  assert.deepEqual(await loadRouterConfig(file), loaded);
  const remaining = withoutRouterProvider(loaded, first);
  await writeFile(file, JSON.stringify(remaining));
  assert.equal((await loadRouterConfig(file)).providers[0].alias, 'relay-2');
  const next = validateRouterConfig(config([{ ...provider('relay-00000000-0000-4000-8000-000000000000') }, ...remaining.providers]));
  assert.equal(next.providers[1].alias, 'relay-2');
});

test('real HTTP exposes short names once, accepts old and new IDs, and preserves group routes and account identity', async t => {
  const seen: Array<{ model: string; auth?: string }> = [];
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); seen.push({ model: body.model, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
  const address = upstream.address(); if (!address || typeof address === 'string') throw Error('listener');
  const providers = [provider(), provider(second)].map(p => ({ ...p, baseUrl: `http://127.0.0.1:${address.port}/v1` }));
  const gateway = new AgentGateway(new RouterCredentials({ KEY_A: 'account-a', KEY_B: 'account-b' })); t.after(() => gateway.stop());
  await gateway.start({ ...config(providers), groups: [{ id: 'fallback', members: [first + '/claude-sonnet-4-6', second + '/claude-sonnet-4-6'] }] });
  const base = gateway.status().baseUrl!; const headers = { authorization: 'Bearer ' + gateway.token(), 'content-type': 'application/json' };
  const catalog = await (await fetch(base + '/models', { headers })).json();
  assert.deepEqual(catalog.data.map((m: any) => m.id), ['relay/claude-sonnet-4-6', 'relay-2/claude-sonnet-4-6', 'auto/fallback']);
  assert.equal(catalog.data[0].display_name, 'Claude Sonnet 4.6');
  for (const [model, auth] of [[first + '/claude-sonnet-4-6', 'account-a'], ['relay/claude-sonnet-4-6', 'account-a'], ['relay-2/claude-sonnet-4-6', 'account-b'], ['auto/fallback', 'account-a']]) {
    const reply = await fetch(base + '/responses', { method: 'POST', headers, body: JSON.stringify({ model, input: 'Hello' }) });
    assert.equal(reply.status, 200); const value = await reply.json(); assert.equal(value.model, model);
    assert.deepEqual(seen.at(-1), { model: 'claude-sonnet-4-6', auth: 'Bearer ' + auth });
  }
  const legacy = await fetch(base.replace('/v1', '/v1beta/models/') + encodeURIComponent(first + '/claude-sonnet-4-6'), { headers });
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).displayName, 'Claude Sonnet 4.6');
  assert.equal((await fetch(base + '/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'relay/hidden', input: 'Hello' }) })).status, 503);
});

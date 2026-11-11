import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticGroups } from '../src/agent-router/groups.js';
import { RoutingState, responseFailure } from '../src/agent-router/routing.js';
import { validateRouterConfig, type AgentRouterConfig, type RouterProvider } from '../src/agent-router/config.js';
const provider = (id: string): RouterProvider => ({ id, name: id, enabled: true, baseUrl: 'https://example.com/v1', protocol: 'chat', models: ['org/model'], auth: { kind: 'env', variable: 'KEY' } });
const config = (): AgentRouterConfig => ({ version: 1, port: 0, autoGroups: true, providers: [provider('a'), provider('b'), { ...provider('c'), protocol: 'messages' }, { ...provider('d'), enabled: false }], groups: [{ id: 'manual', members: ['a/org/model'] }] });
test('automatic groups are opt-in, protocol-specific, derived and preserve manual configuration', () => {
  const input = config(); const before = structuredClone(input);
  assert.deepEqual(automaticGroups({ ...input, autoGroups: false }), []);
  assert.deepEqual(automaticGroups(input), [{ id: 'generated/chat/org%2Fmodel', members: ['a/org/model', 'b/org/model'], strategy: 'ordered' }]);
  assert.deepEqual(input, before); assert.deepEqual(validateRouterConfig(input), input);
  assert.throws(() => validateRouterConfig({ ...input, autoGroups: 'yes' }));
});
test('derived routes share credential filtering, cooldown across client protocols', () => {
  const input = config(); const state = new RoutingState(); const model = 'auto/generated/chat/org%2Fmodel';
  const first = state.plan(input, model, 'chat', () => true); assert.equal(first.candidates.length, 2);
  state.failure(first.candidates[0], responseFailure(429));
  assert.deepEqual(state.plan(input, model, 'chat', () => true).candidates.map(c => c.provider.id), ['b']);
  assert.equal(state.plan(input, model, 'messages', () => true).candidates.length, 1);
  assert.equal(state.plan(input, model, 'chat', () => false).candidates.length, 0);
  assert.equal(state.plan({ ...input, autoGroups: false }, model, 'chat', () => true).candidates.length, 0);
});
test('generated group and member counts are bounded and identifiers distinguish encoded names', () => {
  const input = config(); input.providers = Array.from({ length: 32 }, (_, i) => ({ ...provider('p' + i), models: Array.from({ length: 128 }, (_, n) => 'm' + n) }));
  const groups = automaticGroups(input); assert.equal(groups.length, 128); assert.equal(groups[0].members.length, 16);
  input.providers = [provider('a'), provider('b')].map(p => ({ ...p, models: ['a/b', 'a%2Fb'] }));
  assert.equal(new Set(automaticGroups(input).map(g => g.id)).size, 2);
});

test('gateway catalog and private snapshot expose the same generated identifiers', async t => {
  const { AgentGateway, RouterCredentials } = await import('../src/agent-router/index.js');
  const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fake-key' })); t.after(() => gateway.stop());
  await gateway.start(config());
  const response = await fetch(gateway.status().baseUrl + '/models', { headers: { authorization: `Bearer ${gateway.token()}` } });
  const catalog = await response.json() as { data: Array<{ id: string }> };
  assert.equal(response.status, 200);
  assert.ok(catalog.data.some(m => m.id === 'auto/' + gateway.status().automaticGroups[0].id));
  assert.ok(catalog.data.some(m => m.id === 'auto/manual'));
});

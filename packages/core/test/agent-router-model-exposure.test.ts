import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRouterConfig, type AgentRouterConfig } from '../src/agent-router/config.js';
import { AgentGateway, RouterCredentials } from '../src/agent-router/index.js';
import { RoutingState } from '../src/agent-router/routing.js';
import { automaticGroups } from '../src/agent-router/groups.js';

const config = (): AgentRouterConfig => ({
  version: 1, port: 0, autoGroups: true,
  providers: ['a', 'b'].map(id => ({ id, name: id, enabled: true, protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['one', 'two'], auth: { kind: 'env', variable: 'KEY' } })),
  groups: [{ id: 'manual', members: ['a/one', 'b/one'] }],
});

test('exposure choices persist without losing catalog and reject unknown models', () => {
  const input = config();
  input.providers[0].excludedModels = ['one', 'two'];
  assert.deepEqual(validateRouterConfig(JSON.parse(JSON.stringify(input))), input);
  input.providers[0].excludedModels = ['missing'];
  assert.throws(() => validateRouterConfig(input), /INVALID_MODELS/);
});

test('deselected models cannot route directly or via manual and automatic groups', () => {
  const input = config(); input.providers[0].excludedModels = ['one'];
  const routes = new RoutingState();
  assert.equal(routes.plan(input, 'a/one', 'chat', () => true).candidates.length, 0);
  assert.deepEqual(routes.plan(input, 'auto/manual', 'chat', () => true).candidates.map(c => c.target), ['b/one']);
  assert.ok(!automaticGroups(input).some(g => g.members.includes('a/one')));
  assert.equal(routes.plan(input, 'a/two', 'chat', () => true).candidates.length, 1);
});

test('running gateway updates exposure, permits deselecting all and restores models', async t => {
  const gateway = new AgentGateway(new RouterCredentials({ KEY: 'fake-key' }));
  t.after(() => gateway.stop());
  const input = config(); await gateway.start(input);
  const catalog = async () => {
    const response = await fetch(gateway.status().baseUrl + '/models', { headers: { authorization: `Bearer ${gateway.token()}` } });
    assert.equal(response.status, 200);
    return (await response.json() as { data: { id: string }[] }).data.map(m => m.id);
  };
  assert.ok((await catalog()).includes('a/one'));
  const hidden = structuredClone(input);
  hidden.providers.forEach(p => { p.excludedModels = [...p.models]; });
  let persisted: AgentRouterConfig | undefined;
  await gateway.addProviders(hidden, async next => { persisted = next; });
  assert.deepEqual(persisted, hidden);
  assert.deepEqual(await catalog(), []);
  assert.deepEqual(hidden.providers[0].models, ['one', 'two']);
  await gateway.addProviders(input, async () => {});
  assert.ok((await catalog()).includes('a/one'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionAffinity } from '../src/agent-router/affinity.js';
import { RoutingState, responseFailure } from '../src/agent-router/routing.js';
import { validateRouterConfig, type AgentRouterConfig } from '../src/agent-router/config.js';
const config: AgentRouterConfig = { version: 1, port: 0, sessionAffinity: true, providers: ['a', 'b'].map(id => ({ id, name: id, enabled: true, protocol: 'chat', baseUrl: 'https://example.com', models: ['m'], auth: { kind: 'env', variable: 'KEY' } })), groups: [{ id: 'g', members: ['a/m', 'b/m'] }] };
test('affinity is isolated by route, protocol and session, expires and evicts oldest success', () => {
  let now = 0; const cache = new SessionAffinity(() => now);
  cache.remember('g', 'chat', 's', 'a/m');
  assert.equal(cache.get('g', 'messages', 's'), undefined); assert.equal(cache.get('other', 'chat', 's'), undefined);
  assert.equal(cache.get('g', 'chat', 'other'), undefined); assert.equal(cache.get('g', 'chat', 's'), 'a/m');
  now = 1800000; assert.equal(cache.get('g', 'chat', 's'), undefined);
  for (let n = 0; n < 1025; n++) cache.remember('g', 'chat', String(n), 'a/m');
  assert.equal(cache.get('g', 'chat', '0'), undefined); assert.equal(cache.get('g', 'chat', '1024'), 'a/m');
  cache.reset('a'); assert.equal(cache.get('g', 'chat', '1024'), undefined);
});
test('successful target is preferred without bypassing health, credentials or opt-in', () => {
  const state = new RoutingState(); const plan = () => state.plan(config, 'auto/g', 'chat', () => true, 'private-session');
  const b = plan().candidates[1]; state.remember(b, 'auto/g', 'private-session');
  assert.equal(plan().candidates[0].target, 'b/m'); assert.equal(plan().affinity, true);
  assert.equal(JSON.stringify(plan()).includes('private-session'), false);
  assert.equal(state.plan({ ...config, sessionAffinity: false }, 'auto/g', 'chat', () => true, 'private-session').candidates[0].target, 'a/m');
  assert.equal(state.plan(config, 'auto/g', 'chat', p => p.id !== 'b', 'private-session').candidates[0].target, 'a/m');
  state.failure(b, responseFailure(429)); assert.equal(plan().candidates[0].target, 'a/m'); assert.equal(plan().affinity, false);
});
test('reset and restart reject late preferences from a previous generation', () => {
  const state = new RoutingState(); const b = state.plan(config, 'auto/g', 'chat', () => true).candidates[1];
  state.remember(b, 'auto/g', 's'); state.reset('b'); state.remember(b, 'auto/g', 's');
  assert.equal(state.plan(config, 'auto/g', 'chat', () => true, 's').affinity, false);
  state.clear(); state.remember(b, 'auto/g', 's'); assert.equal(state.plan(config, 'auto/g', 'chat', () => true, 's').affinity, false);
  assert.deepEqual(validateRouterConfig(config), config);
  assert.throws(() => validateRouterConfig({ ...config, sessionAffinity: 'yes' }));
});

test('converted routes pin by client protocol rather than upstream protocol', () => {
  const state = new RoutingState(); const b = state.plan(config, 'auto/g', 'messages', () => true).candidates[1];
  state.remember(b, 'auto/g', 's', 'messages');
  assert.equal(state.plan(config, 'auto/g', 'messages', () => true, 's').candidates[0].provider.id, 'b');
  assert.equal(state.plan(config, 'auto/g', 'chat', () => true, 's').affinity, false);
});

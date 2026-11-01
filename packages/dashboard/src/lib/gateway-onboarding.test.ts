import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTER_PRESETS } from '@juejin-opensource/jusage-core/agent-router/presets';
import { authorizationAccount, connectGatewayTool } from './gateway-onboarding.ts';
import type { AgentRouterConfig, RouterProvider } from '@juejin-opensource/jusage-core/agent-router';

function fixture(phase: 'running' | 'stopped' | 'draining' = 'running') {
  const events: string[] = [];
  let config: AgentRouterConfig = { version: 1, port: 18453, providers: [], groups: [] };
  let created: RouterProvider | undefined;
  const actions = {
    snapshot: async () => ({ config, presets: ROUTER_PRESETS, phase, error: null, credentialError: null }),
    save: async (next: AgentRouterConfig) => { events.push('save'); config = next; },
    start: async () => { events.push('start'); },
    remove: async (id: string) => { events.push('remove'); config = { ...config, providers: config.providers.filter(p => p.id !== id) }; },
    login: async (id: string) => { events.push('login'); assert.equal(id, created?.id); return { url: 'https://auth.example.com/login' }; },
    openExternal: async (url: string) => { events.push('open'); assert.equal(url, 'https://auth.example.com/login'); },
    onCreated: (provider: RouterProvider) => { events.push('created'); created = provider; },
    onAuthorization: (id: string, url: string) => { events.push('authorization'); assert.equal(id, created?.id); assert.equal(url, 'https://auth.example.com/login'); },
  };
  return { actions, events, config: () => config };
}

test('selecting OAuth tool persists an independent account and opens authorization directly', async () => {
  const f = fixture();
  const first = await connectGatewayTool('claude', f.actions);
  assert.deepEqual(f.events, ['save', 'created', 'login', 'authorization', 'open']);
  assert.equal(first.auth.kind, 'subscription');
  assert.equal(first.auth.kind === 'subscription' && first.auth.method, 'browser');
  assert.equal(first.enabled, true);
  const second = await connectGatewayTool('claude', f.actions);
  assert.notEqual(second.id, first.id);
  assert.equal(first.name, ROUTER_PRESETS.find(p => p.id === 'claude')!.name);
  assert.equal(second.name, first.name);
  assert.equal(f.config().providers.length, 2);
});

test('stopped gateway starts after saving and before authorization', async () => {
  const f = fixture('stopped');
  await connectGatewayTool('codex', f.actions);
  assert.deepEqual(f.events, ['save', 'created', 'start', 'login', 'authorization', 'open']);
});

test('API key channels and draining gateway do not create accounts', async () => {
  const f = fixture('draining');
  await assert.rejects(connectGatewayTool('deepseek-api', f.actions), /API Key/);
  await assert.rejects(connectGatewayTool('codex', f.actions), /切换状态/);
  assert.deepEqual(f.events, []);
});

test('failed persistence never starts gateway or opens authorization', async () => {
  const f = fixture('stopped');
  f.actions.save = async () => { throw new Error('save failed'); };
  await assert.rejects(connectGatewayTool('codex', f.actions), /save failed/);
  assert.deepEqual(f.events, []);
});

test('authorization failure removes only the newly created account', async () => {
  const f = fixture();
  const existing = await connectGatewayTool('codex', f.actions);
  f.events.length = 0;
  f.actions.login = async () => { throw new Error('login failed'); };
  await assert.rejects(connectGatewayTool('codex', f.actions), /login failed/);
  assert.equal(f.config().providers.length, 1);
  assert.equal(f.config().providers[0].id, existing.id);
  assert.deepEqual(f.events, ['save', 'created', 'remove']);
});

test('browser opening failure retains an authorization link for retry', async () => {
  const f = fixture();
  f.actions.openExternal = async () => { throw new Error('open failed'); };
  await assert.rejects(connectGatewayTool('claude', f.actions), /open failed/);
  assert.deepEqual(f.events, ['save', 'created', 'login', 'authorization']);
  assert.equal(f.config().providers.length, 1);
});

test('invalid authorization URL is never opened', async () => {
  const f = fixture();
  f.actions.login = async () => ({ url: 'javascript:alert(1)' });
  await assert.rejects(connectGatewayTool('claude', f.actions), /授权链接无效/);
  assert.equal(f.config().providers.length, 0);
  assert.deepEqual(f.events, ['save', 'created', 'remove']);
});

test('local channel login can continue without an external URL', async () => {
  const f = fixture(); f.actions.login = async () => ({ url: '' });
  await connectGatewayTool('claude', f.actions);
  assert.deepEqual(f.events, ['save', 'created']);
  assert.equal(f.config().providers.length, 1);
});

test('new subscription accounts use their native protocol instead of assuming Chat', async () => {
  const f = fixture(); const provider = await connectGatewayTool('claude', f.actions);
  assert.equal(provider.protocol, 'messages');
  assert.ok(provider.models.length);
});

test('an older host cannot persist a subscription offered only by a newer frontend', async () => {
  const f = fixture();
  const snapshot = await f.actions.snapshot();
  f.actions.snapshot = async () => ({ ...snapshot, presets: [] });
  await assert.rejects(connectGatewayTool('cursor', f.actions), /尚不支持/);
  assert.deepEqual(f.events, []);
});

test('connection uses the running host endpoint and model defaults', async () => {
  const f = fixture(); const snapshot = await f.actions.snapshot();
  f.actions.snapshot = async () => ({ ...snapshot, presets: snapshot.presets.map(p => p.id === 'claude' ? { ...p, endpoints: { messages: 'https://copilot.tencent.com/new-v1' }, models: ['host-selected-model'] } : p) });
  const provider = await connectGatewayTool('claude', f.actions);
  assert.deepEqual(provider.models, ['host-selected-model']);
  assert.equal(provider.protocol, 'messages');
  assert.equal(provider.baseUrl, 'https://copilot.tencent.com/new-v1');
});

test('missing host capability metadata asks for restart before changing config', async () => {
  const f = fixture();
  await assert.rejects(connectGatewayTool('cursor', { ...f.actions, snapshot: async () => {
    const { presets: _presets, ...olderHost } = await f.actions.snapshot(); return olderHost;
  } }), /重启/);
  assert.deepEqual(f.events, []);
});


test('gateway start failure rolls back the new account', async () => {
  const f = fixture('stopped');
  f.actions.start = async () => { throw new Error('start failed'); };
  await assert.rejects(connectGatewayTool('claude', f.actions), /start failed/);
  assert.equal(f.config().providers.length, 0);
});

test('failed or cancelled new authorization is removed once and can retry', async () => {
  const events: string[] = [];
  const account = authorizationAccount(true, {
    restore: async () => { events.push('restore'); },
    remove: async () => { events.push('remove'); },
  });
  await Promise.all([account.rollback(), account.rollback()]);
  await account.ensure();
  await account.ensure();
  await account.rollback();
  assert.deepEqual(events, ['remove', 'restore', 'remove']);
});

test('existing and successfully authenticated accounts survive close or refresh failures', async () => {
  for (const isNew of [false, true]) {
    const events: string[] = [];
    const account = authorizationAccount(isNew, {
      restore: async () => { events.push('restore'); },
      remove: async () => { events.push('remove'); },
    });
    if (isNew) account.commit();
    await account.rollback();
    await account.ensure();
    assert.deepEqual(events, []);
  }
});

test('failed cleanup remains retryable instead of marking the account removed', async () => {
  let attempts = 0;
  const account = authorizationAccount(true, {
    restore: async () => { assert.fail('already present'); },
    remove: async () => { if (++attempts === 1) throw new Error('busy'); },
  });
  await assert.rejects(account.rollback(), /busy/);
  await account.rollback();
  assert.equal(attempts, 2);
});


test('Claude and Codex onboarding selects the native protocol', async () => {
  for (const [id, protocol] of [['claude', 'messages'], ['codex', 'responses']]) {
    const f = fixture();
    const provider = await connectGatewayTool(id, f.actions);
    assert.equal(provider.protocol, protocol);
    assert.equal(provider.auth.kind, 'subscription');
  }
});

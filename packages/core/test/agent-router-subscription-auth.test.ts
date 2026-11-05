import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL_CATALOG, makeRouterPreset } from '../src/agent-router/presets.js';
import { RouterSubscriptions } from '../src/agent-router/subscriptions.js';
import { RouterCredentialStore } from '../src/agent-router/credential-store.js';
import { validateRouterConfig } from '../src/agent-router/config.js';
import { normalizeSubscriptionAuth, subscriptionAuthReader, validSubscriptionAuth, validLoginUrl } from '../src/agent-router/subscription-auth.js';


test('subscription catalog matches both page pickers', async () => {
  assert.equal(CHANNEL_CATALOG.length, 22);
  assert.equal(new Set(CHANNEL_CATALOG.map(c => c.id)).size, 22);
  for (const path of ['packages/dashboard/src/components/AIGatewayCard.tsx', 'apps/desktop/src/renderer/components/AIGatewayCard.tsx']) {
    const source = await readFile(new URL('../../../../' + path, import.meta.url), 'utf8');
    assert.ok(source.includes('new Set(CHANNEL_CATALOG.map('), path);
  }
});

test('all statically linked channels expose login methods without network access', async t => {
  const manager = new RouterSubscriptions(); t.after(() => manager.close());
  for (const channel of CHANNEL_CATALOG) {
    const provider = makeRouterPreset(channel.id, channel.protocol);
    assert.doesNotThrow(() => validateRouterConfig({ version: 1, port: 18453, providers: [provider], groups: [] }));
    const methods = await manager.methods(provider);
    assert.ok(methods.length, channel.id);
    assert.ok(methods.every(m => m.label && ['oauth', 'api'].includes(m.type)), channel.id);
  }
});

test('channel credentials cover refresh-only OAuth and local references without weakening plain API validation', () => {
  assert.ok(validSubscriptionAuth({ type: 'oauth', refresh: 'github-device-token', access: '' }));
  assert.ok(validSubscriptionAuth({ type: 'oauth', source: 'gcloud', project: 'fake-project', access: '' }));
  assert.ok(validSubscriptionAuth({ type: 'api', key: 'uin=fake; skey=fake' }));
  assert.equal(validSubscriptionAuth({ type: 'oauth', access: '' }), false);
  assert.equal(validSubscriptionAuth({ type: 'api', key: 'bad\nkey' }), false);
  assert.throws(() => normalizeSubscriptionAuth({ type: 'failed' }), /LOGIN_FAILED/);
  assert.equal(normalizeSubscriptionAuth({ type: 'oauth', refresh: 'saved-token', access: '' }).type, 'oauth');
});

test('browser authorization permits HTTPS and local callbacks only', () => {
  assert.ok(validLoginUrl('https://github.com/login/device'));
  assert.ok(validLoginUrl('http://127.0.0.1:3489/login'));
  assert.equal(validLoginUrl('javascript:alert(1)'), false);
  assert.equal(validLoginUrl('http://public.example/login'), false);
  assert.equal(validLoginUrl('https://user:password@example.com'), false);
});

test('idle authenticated channels can be evicted and restored without losing encrypted credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'channel-lru-'));
  const store = new RouterCredentialStore(join(root, 'credentials.enc'), Buffer.alloc(32, 19)); await store.init();
  const manager = new RouterSubscriptions({}, undefined, store); t.after(() => manager.close());
  const providers = Array.from({ length: 10 }, (_, index) => ({ ...makeRouterPreset('codex', 'responses'), id: `account-${index}` }));
  for (const provider of providers) {
    await store.set(provider, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-saved-access' } });
    await manager.methods(provider);
  }
  assert.equal(manager.ready(providers[0]), true);
  assert.ok((await manager.methods(providers[0])).length);
  assert.equal(manager.ready(providers[0]), true);
});

test('channel refresh is shared across concurrent reads and preserves opaque vendor metadata', async () => {
  let auth: import('../src/agent-router/subscription-types.js').SubscriptionAuth = { type: 'oauth', access: 'old', refresh: 'one-use', expires: 2000, provider: 'native', metadata: { domain: 'fake' } };
  let renewals = 0, saves = 0;
  const channel = { models: async () => ({}), auth: { methods: [], transport: async () => ({}), refreshLead: 1000, refresh: async (current: typeof auth) => {
    assert.equal(current.refresh, 'one-use'); renewals++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { access: 'new', refresh: 'rotated', expires: 9000 };
  } } };
  const read = subscriptionAuthReader(() => auth, async next => { saves++; auth = next; }, async () => channel, () => 1500);
  const values = await Promise.all(Array.from({ length: 10 }, () => read()));
  assert.equal(renewals, 1); assert.equal(saves, 1);
  assert.ok(values.every(value => value.access === 'new'));
  assert.equal(auth.provider, 'native'); assert.deepEqual(auth.metadata, { domain: 'fake' });
  await read(); assert.equal(renewals, 1);
});



test('rotated credentials survive a transient vault failure without reusing the old refresh token', async () => {
  let auth: import('../src/agent-router/subscription-types.js').SubscriptionAuth = { type: 'oauth', access: 'old', refresh: 'single-use', expires: 1 };
  let renewals = 0, saves = 0;
  const channel = { models: async () => ({}), auth: { methods: [], transport: async () => ({}), refresh: async () => { renewals++; return { access: 'new', refresh: 'rotated', expires: Date.now() + 3600000 }; } } };
  const read = subscriptionAuthReader(() => auth, async next => { if (++saves === 1) throw new Error('vault unavailable'); auth = next; }, async () => channel);
  await assert.rejects(read(), /SUBSCRIPTION_REFRESH_FAILED/);
  assert.equal(auth.access, 'old');
  assert.equal((await read()).access, 'new');
  assert.equal(renewals, 1); assert.equal(saves, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUsage, usageAccountName } from '../src/agent-router/usage.js';
import { makeRouterPreset, validateRouterConfig } from '../src/agent-router/index.js';
test('usage exposes only bounded numbers and approved units, never raw errors or account data', () => {
  const usage = sanitizeUsage({ plan: 'private-account', windows: [{ name: 'secret', display: 'token', amount: 25, limit: 100, used: 25, unit: 'credits' }, { balance: 0, unit: 'USD' }] });
  assert.equal(usage.state, 'available'); assert.deepEqual(usage.windows[0], { percent: 25, used: 25, limit: 100, unit: 'credits' });
  assert.equal(JSON.stringify(usage).includes('secret'), false); assert.equal(JSON.stringify(usage).includes('private-account'), false);
  assert.equal(sanitizeUsage({ error: 'secret', windows: [{ balance: 10 }] }).state, 'unknown');
  assert.equal(sanitizeUsage({ signIn: 'expired' }).state, 'expired');
  assert.equal(sanitizeUsage({ windows: [{ balance: NaN }, { amount: -1 }] }).state, 'unknown');
  assert.equal(sanitizeUsage({ windows: Array.from({ length: 20 }, () => ({ balance: 1 })) }).windows.length, 8);
});
test('new API presets pin official endpoints and environment references', () => {
  for (const id of ['deepseek-api', 'siliconflow-cn-api']) {
    const p = makeRouterPreset(id); assert.equal(p.auth.kind, 'env');
    assert.equal(validateRouterConfig({ version: 1, port: 0, providers: [p], groups: [] }).providers[0].preset, id);
    assert.throws(() => validateRouterConfig({ version: 1, port: 0, providers: [{ ...p, baseUrl: 'https://evil.example' }], groups: [] }));
    assert.throws(() => makeRouterPreset(id, 'messages'));
  }
  assert.equal(makeRouterPreset('deepseek-api').baseUrl, 'https://api.deepseek.com');
  assert.equal(makeRouterPreset('siliconflow-cn-api').baseUrl, 'https://api.siliconflow.cn/v1');
});
test('account cards retain recognized plans and reset dates without exposing arbitrary vendor labels', () => {
  const usage = sanitizeUsage({ plan: 'Free plan', windows: [{ amount: 3.18, limit: 500, used: 0.636, unit: 'credits', resetsAt: '2026-12-01T00:00:00+08:00' }] });
  assert.equal(usage.plan, 'Free plan');
  assert.equal(usage.windows[0].resetsAt, '2026-11-30T16:00:00.000Z');
  assert.equal(sanitizeUsage({ plan: 'token-secret' }).plan, undefined);
  assert.equal(sanitizeUsage({ windows: [{ amount: 1, resetsAt: 'invalid' }] }).windows[0].resetsAt, undefined);
  assert.equal(usageAccountName('codex', { type: 'oauth', accountName: 'Alice', access: 'secret' }), 'Alice');
  assert.equal(usageAccountName('codex', { type: 'oauth', accountName: 'secret', access: 'secret' }), undefined);
  assert.equal(usageAccountName('codex', { type: 'api', accountName: 'Alice' }), undefined);
  assert.equal(usageAccountName('other', { type: 'oauth', accountName: 'Alice' }), undefined);
});

test('all supported channels expose only whitelisted account fields, including API-authenticated subscriptions', async () => {
  const { accountDetails } = await import('../src/agent-router/usage.js');
  assert.deepEqual(accountDetails('workbuddy', { type: 'oauth', accountName: 'Alice', uid: 'u1', email: 'alice@example.com', plan: 'Pro', access: 'private-token' }), { accountName: 'Alice', accountId: 'u1', email: 'alice@example.com', plan: 'Pro' });
  assert.deepEqual(accountDetails('zcode', { type: 'api', accountName: 'Alice', uid: 'u1', key: 'private-key' }), { accountName: 'Alice', accountId: 'u1' });
  assert.deepEqual(accountDetails('cursor', { access: 'private-token' }, { accountName: 'private-token', email: 'bad\nemail', accountId: 'Bearer secret', plan: 'private-token' }), {});
  assert.deepEqual(accountDetails('kiro', { type: 'oauth', source: 'kiro-local', uid: 'internal-hash' }), {});
});

test('account information survives quota failures and quota survives profile failures', async () => {
  const { readSubscriptionDetails } = await import('../src/agent-router/usage.js');
  const auth = { type: 'oauth', accountName: 'Saved name', uid: 'u1', plan: 'Pro', access: 'secret' };
  const base = { models: async () => ({}), auth: { methods: [], transport: async () => ({}) } };
  const info = await readSubscriptionDetails('cursor', { ...base, auth: { ...base.auth, account: async () => ({ accountName: 'Live name', email: 'alice@example.com' }), usage: async () => { throw new Error('quota down secret'); } } }, async () => auth);
  assert.equal(info.accountName, 'Live name'); assert.equal(info.email, 'alice@example.com'); assert.equal(info.plan, 'Pro'); assert.equal(info.state, 'unknown');
  const fallback = await readSubscriptionDetails('cursor', { ...base, auth: { ...base.auth, account: async () => { throw new Error('profile down secret'); }, usage: async () => ({ windows: [{ used: 25 }] }) } }, async () => auth);
  assert.equal(fallback.accountName, 'Saved name'); assert.equal(fallback.state, 'available'); assert.equal(fallback.accountError, true);
  assert.equal(JSON.stringify([info, fallback]).includes('secret'), false);
  const expired = await readSubscriptionDetails('cursor', base, async () => { throw new Error('SUBSCRIPTION_LOGIN_REQUIRED'); }, auth);
  assert.equal(expired.accountName, 'Saved name'); assert.equal(expired.state, 'expired');
});

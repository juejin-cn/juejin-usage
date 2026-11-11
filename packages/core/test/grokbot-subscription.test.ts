import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGrokBotSubscriptionReader, grokBotActiveCredentials } from '../src/subscription/readers/grokbot-subscription.js';
import { mapGrokBotUsage } from '../src/subscription/shared/grokbot-subscription.js';
import { sealCursorAccessTokenWindowsForTests, CURSOR_SAFE_STORAGE_PREFIX } from '../src/subscription/readers/cursor-safe-storage.js';

const usage = { hasNonZeroIncludedLimit: true, usagePercent: 25, nextResetTimestampUtc: '2027-01-01T00:00:00Z', grokPlanLabel: 'SuperGrok' };
const plain = (s: string) => `plaintext:v1:${Buffer.from(s).toString('base64')}`;
function store(token = plain('test-token')) {
  return { version: 1, 'cursor-accounts': JSON.stringify({ active: 'account-a', accounts: {
    'account-a': { 'cursor-access-token': token }, 'account-b': { 'cursor-access-token': plain('other-account') },
  } }) };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-subscription-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'sand-secrets.json');
  await writeFile(file, JSON.stringify(store()));
  return file;
}

test('active account selection supports legacy storage and never falls back after logout', () => {
  assert.equal(grokBotActiveCredentials(store())?.token, plain('test-token'));
  assert.equal(grokBotActiveCredentials({ version: 1, 'cursor-access-token': plain('legacy') })?.token, plain('legacy'));
  const value = store();
  value['cursor-accounts'] = JSON.stringify({ active: null, accounts: { a: { 'cursor-access-token': plain('old') } } });
  assert.equal(grokBotActiveCredentials({ ...value, 'cursor-access-token': plain('legacy') }), null);
  assert.throws(() => grokBotActiveCredentials({ version: 2 }));
});

test('maps confirmed zero/weekly/trial quotas, rejects unknown and organization pools', () => {
  assert.equal(mapGrokBotUsage(usage).weekly?.usedPercent, 25);
  assert.equal(mapGrokBotUsage({ ...usage, usagePercent: 0 }).weekly?.usedPercent, 0);
  assert.equal(mapGrokBotUsage({ ...usage, usesPooledEnterpriseAllowance: true }).weekly, null);
  assert.equal(mapGrokBotUsage({ usagePercent: 0 }).weekly, null);
  assert.equal(mapGrokBotUsage({ ...usage, usagePercent: '25' }).weekly, null);
  const trial = mapGrokBotUsage({ usagePercent: 10, sandTrialExpiresAt: '2027-01-01T00:00:00Z' }, Date.parse('2026-01-01'));
  assert.equal(trial.weekly?.resetsAt, null);
  assert.ok(trial.weekly?.expiresAt);
});

test('reads standalone credentials, binds team context and sends only to the official billing service', async t => {
  const file = await fixture(t);
  const value = store();
  const accounts = JSON.parse(value['cursor-accounts']);
  accounts.accounts['account-a']['cursor-selected-team-id'] = plain('123');
  value['cursor-accounts'] = JSON.stringify(accounts);
  await writeFile(file, JSON.stringify(value));
  let calls = 0;
  const reader = createGrokBotSubscriptionReader({ authPath: file, fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-token');
    assert.equal(headers.get('x-cursor-team-id'), '123');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{}');
    assert.ok(init?.signal);
    return Response.json(usage);
  } });
  assert.equal((await reader()).status, 'ready');
  assert.equal((await reader()).weekly?.usedPercent, 25);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(await reader()).includes('test-token'), false);
  await reader({ forceRefresh: true });
  assert.equal(calls, 2);
});

test('macOS unlock only happens on manual refresh, with a separate Grok Bot key', async t => {
  const file = await fixture(t);
  const key = pbkdf2Sync('grokbot-test-password', 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update('mac-token'), cipher.final()]).toString('base64');
  await writeFile(file, JSON.stringify(store(`scoped:v1:${'a'.repeat(64)}:${encrypted}`)));
  let prompts = 0;
  let calls = 0;
  const reader = createGrokBotSubscriptionReader({ authPath: file, platform: 'darwin',
    readKeychainPassword: async () => { prompts++; return 'grokbot-test-password'; },
    fetch: async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mac-token'); return Response.json(usage); },
  });
  assert.equal((await reader()).status, 'unavailable');
  assert.equal(prompts, 0); assert.equal(calls, 0);
  assert.equal((await reader({ forceRefresh: true })).status, 'ready');
  assert.equal(prompts, 1); assert.equal(calls, 1);
});

test('Windows uses the Bot OSCrypt key without borrowing Cursor credentials', async t => {
  const file = await fixture(t);
  const key = Buffer.alloc(32, 42);
  await writeFile(file, JSON.stringify(store(sealCursorAccessTokenWindowsForTests('win-token', key).slice(CURSOR_SAFE_STORAGE_PREFIX.length))));
  const reader = createGrokBotSubscriptionReader({ authPath: file, platform: 'win32', readWindowsKey: async () => Buffer.from(key),
    fetch: async (_url, init) => { assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer win-token'); return Response.json(usage); },
  });
  assert.equal((await reader()).status, 'ready');
});

test('changed credentials invalidate cache and in-flight responses cannot cross accounts', async t => {
  const file = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const reader = createGrokBotSubscriptionReader({ authPath: file, fetch: async () => { entered(); await gate; return Response.json(usage); } });
  const pending = reader();
  await started;
  await writeFile(file, JSON.stringify({ version: 1, 'cursor-accounts': JSON.stringify({ active: null, accounts: {} }) }));
  release();
  assert.equal((await pending).status, 'unavailable');
  assert.equal((await reader()).status, 'not-signed-in');
});

test('network, authentication, malformed store and missing store return actionable sanitized states', async t => {
  const file = await fixture(t);
  for (const status of [401, 403, 500]) {
    const reader = createGrokBotSubscriptionReader({ authPath: file, fetch: async () => new Response('sensitive vendor body', { status }) });
    const result = await reader();
    assert.equal(result.status, status === 500 ? 'unavailable' : 'not-signed-in');
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
  }
  const reader = createGrokBotSubscriptionReader({ authPath: file, fetch: async () => { throw new Error('secret-token'); } });
  assert.equal(JSON.stringify(await reader()).includes('secret-token'), false);
  await writeFile(file, '{broken');
  assert.equal((await reader()).status, 'unavailable');
  await rm(file);
  assert.equal((await reader()).status, 'not-installed');
});

test('successful quota cache is invalidated when the active credential changes', async t => {
  const file = await fixture(t);
  const tokens: string[] = [];
  const reader = createGrokBotSubscriptionReader({ authPath: file, fetch: async (_url, init) => {
    tokens.push(new Headers(init?.headers).get('authorization')!);
    return Response.json(usage);
  } });
  assert.equal((await reader()).status, 'ready');
  assert.equal((await reader()).status, 'ready');
  assert.equal(tokens.length, 1);
  await writeFile(file, JSON.stringify(store(plain('new-account'))));
  assert.equal((await reader()).status, 'ready');
  assert.deepEqual(tokens, ['Bearer test-token', 'Bearer new-account']);
});

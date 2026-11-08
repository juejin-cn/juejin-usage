import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createQoderAppAuthReader } from './qoder-app-auth';

const password = 'fixture-keychain-password';
const account = {
  schemaVersion: 1,
  token: 'fixture-qoder-access-token',
  refreshToken: 'must-not-be-returned-or-used',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: 'fixture-user-id' },
};

function encrypt(value: unknown): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v10'), cipher.update(JSON.stringify(value)), cipher.final()]);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qoder-app-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, 'auth.v1.dat');
  const statusPath = path.join(directory, '.qoder-app-status.json');
  await writeFile(authPath, encrypt(account));
  await writeFile(statusPath, JSON.stringify({ logged_in: true }));
  return { authPath, statusPath };
}

test('mac reader requires a manual refresh before asking the keychain and caches only successful access', async t => {
  const files = await fixture(t);
  let keychainReads = 0;
  const read = createQoderAppAuthReader({
    ...files, platform: 'darwin',
    readKeychainPassword: async () => { keychainReads += 1; return password; },
  });
  assert.deepEqual(await read(), {
    kind: 'unavailable', message: '点击刷新读取 Qoder 登录信息；系统弹窗中可选择“始终允许”以避免重复授权',
  });
  assert.equal(keychainReads, 0);
  const result = await read({ allowKeychainPrompt: true });
  assert.equal(result?.kind, 'account');
  if (result?.kind !== 'account') return;
  assert.equal(result.token, account.token);
  assert.equal(result.userId, account.user.id);
  assert.equal(result.expiresAt, Date.parse(account.expiresAt));
  assert.equal('refreshToken' in result, false);
  assert.equal(JSON.stringify(result).includes(account.refreshToken), false);
  assert.equal(result.identity.includes(account.token), false);
  assert.equal(await result.validateIdentity(), true);
  assert.equal((await read())?.kind, 'account');
  assert.equal(keychainReads, 1);
});

test('denied keychain access exposes no error or credential and retries only on manual refresh', async t => {
  const files = await fixture(t);
  let keychainReads = 0;
  const read = createQoderAppAuthReader({
    ...files, platform: 'darwin',
    readKeychainPassword: async () => {
      keychainReads += 1;
      if (keychainReads === 1) throw new Error(account.token);
      return password;
    },
  });
  const denied = await read({ allowKeychainPrompt: true });
  assert.deepEqual(denied, {
    kind: 'unavailable', message: '无法读取 Qoder 登录信息，请在系统钥匙串弹窗中授权后重试；选择“始终允许”可避免重复授权',
  });
  assert.equal((await read())?.kind, 'unavailable');
  assert.equal(keychainReads, 1);
  assert.equal((await read({ allowKeychainPrompt: true }))?.kind, 'account');
  assert.equal(keychainReads, 2);
});

test('explicit logout wins over saved credentials and invalidates the in-memory key', async t => {
  const files = await fixture(t);
  let keychainReads = 0;
  const read = createQoderAppAuthReader({
    ...files, platform: 'darwin',
    readKeychainPassword: async () => { keychainReads += 1; return password; },
  });
  const result = await read({ allowKeychainPrompt: true });
  assert.equal(result?.kind, 'account');
  await writeFile(files.statusPath, JSON.stringify({ logged_in: false }));
  assert.deepEqual(await read({ allowKeychainPrompt: true }), { kind: 'signed-out' });
  if (result?.kind === 'account') assert.equal(await result.validateIdentity(), false);
  await writeFile(files.statusPath, JSON.stringify({ logged_in: true }));
  assert.equal((await read())?.kind, 'unavailable');
  assert.equal(keychainReads, 1);
});

test('account changes invalidate a previous identity even when the old request is still in flight', async t => {
  const files = await fixture(t);
  const read = createQoderAppAuthReader({ ...files, platform: 'darwin', readKeychainPassword: async () => password });
  const first = await read({ allowKeychainPrompt: true });
  await writeFile(files.authPath, encrypt({ ...account, token: 'another-account-access-token', user: { id: 'another-user' } }));
  const second = await read();
  assert.equal(first?.kind, 'account');
  assert.equal(second?.kind, 'account');
  if (first?.kind !== 'account' || second?.kind !== 'account') return;
  assert.notEqual(first.identity, second.identity);
  assert.equal(await first.validateIdentity(), false);
  assert.equal(await second.validateIdentity(), true);
});

test('missing login status does not infer a signed-in account from an old auth file', async t => {
  const files = await fixture(t);
  await rm(files.statusPath);
  let keychainReads = 0;
  const read = createQoderAppAuthReader({
    ...files, platform: 'darwin',
    readKeychainPassword: async () => { keychainReads += 1; return password; },
  });
  assert.equal((await read({ allowKeychainPrompt: true }))?.kind, 'unavailable');
  assert.equal(keychainReads, 0);
  await rm(files.authPath);
  assert.equal(await read(), null);
});

test('Windows uses only the supplied safeStorage decryptor and Linux reports unsupported storage', async t => {
  const files = await fixture(t);
  let decrypted = false;
  const windows = createQoderAppAuthReader({
    ...files, platform: 'win32',
    decryptString: bytes => { decrypted = bytes.equals(encrypt(account)); return JSON.stringify(account); },
    readKeychainPassword: async () => { throw new Error('Windows must never read the mac keychain'); },
  });
  assert.equal((await windows())?.kind, 'account');
  assert.equal(decrypted, true);
  assert.equal((await createQoderAppAuthReader({ ...files, platform: 'linux' })())?.kind, 'unavailable');
});

test('unrecognized auth schemas, invalid expiry, and corrupt ciphertext do not produce credentials', async t => {
  const files = await fixture(t);
  const read = createQoderAppAuthReader({ ...files, platform: 'darwin', readKeychainPassword: async () => password });
  for (const value of [
    { ...account, schemaVersion: 2 },
    { ...account, token: '' },
    { ...account, token: `${account.token}\rInjected: value` },
    { ...account, token: `${account.token}\nInjected: value` },
    { ...account, user: { id: '' } },
    { ...account, expiresAt: 'invalid' },
    { schemaVersion: 1, refreshToken: account.token, user: account.user, expiresAt: account.expiresAt },
  ]) {
    await writeFile(files.authPath, encrypt(value));
    assert.equal((await read({ allowKeychainPrompt: true }))?.kind, 'unavailable');
  }
  await writeFile(files.authPath, Buffer.from('v11unsupported-data'));
  assert.equal((await read({ allowKeychainPrompt: true }))?.kind, 'unavailable');
});

test('logout while awaiting keychain authorization does not return the old account', async t => {
  const files = await fixture(t);
  const read = createQoderAppAuthReader({
    ...files, platform: 'darwin',
    readKeychainPassword: async () => {
      await writeFile(files.statusPath, JSON.stringify({ logged_in: false }));
      return password;
    },
  });
  assert.notEqual((await read({ allowKeychainPrompt: true }))?.kind, 'account');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RouterCredentialStore, RouterCredentials, RouterSubscriptions, makeRouterPreset, type RouterProvider } from '../src/agent-router/index.js';

const provider: RouterProvider = { id: 'custom', name: 'Custom', protocol: 'chat', baseUrl: 'https://example.com/v1', models: ['model'], enabled: true, auth: { kind: 'env', variable: 'TEST_KEY' } };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-vault-'));
  const path = join(directory, 'private', 'credentials.enc'); const key = randomBytes(32);
  const store = new RouterCredentialStore(path, key); await store.init(); return { store, path, key };
}

test('encrypted credentials survive restart, preserve gateway token, and never appear in files', async () => {
  const { store, path, key } = await setup();
  await store.set(provider, { kind: 'api', key: 'private-api-secret' });
  const token = await store.gatewayToken();
  assert.match(token, /^sk-[A-Za-z0-9_-]{43}$/);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('private-api-secret'), false); assert.equal(raw.includes(token), false);
  const reopened = new RouterCredentialStore(path, key); await reopened.init();
  assert.equal(reopened.error, null); assert.deepEqual(reopened.get(provider), { kind: 'api', key: 'private-api-secret' });
  assert.equal(await reopened.gatewayToken(), token);
  const rotated = await reopened.gatewayToken(true);
  assert.notEqual(rotated, token); assert.match(rotated, /^sk-[A-Za-z0-9_-]{43}$/);
  const credentials = new RouterCredentials({}, Date.now, undefined, reopened);
  assert.equal(await credentials.resolve(provider), 'private-api-secret');
  await credentials.logout(provider); await reopened.flush();
  const final = new RouterCredentialStore(path, key); await final.init(); assert.equal(final.get(provider), undefined);
  if (process.platform !== 'win32') { assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700); }
});

test('credential identity cannot be redirected to another host, protocol or auth reference', async () => {
  const { store } = await setup(); await store.set(provider, { kind: 'api', key: 'bound-secret' });
  assert.equal(store.get({ ...provider, baseUrl: 'https://evil.example/v1' }), undefined);
  assert.equal(store.get({ ...provider, protocol: 'messages' }), undefined);
  assert.equal(store.get({ ...provider, auth: { kind: 'env', variable: 'OTHER_KEY' } }), undefined);
  assert.ok(store.get({ ...provider, name: 'New display name', models: ['other-model'] }));
});

test('wrong keys, moved files and tampered ciphertext fail closed without overwriting data', async () => {
  const { store, path, key } = await setup(); await store.set(provider, { kind: 'api', key: 'private-secret' });
  const original = await readFile(path, 'utf8');
  const wrong = new RouterCredentialStore(path, randomBytes(32)); await wrong.init();
  assert.equal(wrong.error, 'CREDENTIAL_STORE_UNREADABLE'); assert.equal(wrong.get(provider), undefined);
  await assert.rejects(wrong.set(provider, { kind: 'api', key: 'replacement' })); assert.equal(await readFile(path, 'utf8'), original);
  const movedPath = path + '.copied'; await copyFile(path, movedPath);
  const moved = new RouterCredentialStore(movedPath, key); await moved.init(); assert.equal(moved.error, 'CREDENTIAL_STORE_UNREADABLE');
  const envelope = JSON.parse(original); const encrypted = Buffer.from(envelope.ciphertext, 'base64'); encrypted[0] ^= 1;
  await writeFile(path, JSON.stringify({ ...envelope, ciphertext: encrypted.toString('base64') }));
  const corrupted = new RouterCredentialStore(path, key); await corrupted.init(); assert.equal(corrupted.error, 'CREDENTIAL_STORE_UNREADABLE');
});

test('unavailable native key never falls back to a plaintext file or accepts legacy plaintext as ciphertext', async () => {
  const { path, key } = await setup();
  const unavailable = new RouterCredentialStore(path); await unavailable.init();
  assert.equal(unavailable.error, 'SECURE_STORAGE_UNAVAILABLE');
  await assert.rejects(unavailable.set(provider, { kind: 'api', key: 'should-never-be-written' }));
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const plaintext = JSON.stringify({ version: 1, entries: {} }); await writeFile(path, plaintext);
  const refused = new RouterCredentialStore(path, key); await refused.init(); assert.equal(refused.error, 'CREDENTIAL_STORE_UNREADABLE');
  assert.equal(await readFile(path, 'utf8'), plaintext);
});

test('vault refuses symlinked files and directories', { skip: process.platform === 'win32' }, async () => {
  const { path, key } = await setup(); const target = path + '.target'; await writeFile(target, 'untouched'); await symlink(target, path);
  const store = new RouterCredentialStore(path, key); await store.init(); assert.equal(store.error, 'CREDENTIAL_STORE_UNREADABLE');
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  const link = join(path, '..', 'linked-directory'); await symlink(join(path, '..'), link);
  const linked = new RouterCredentialStore(join(link, 'credentials.enc'), key); await linked.init(); assert.equal(linked.error, 'CREDENTIAL_STORE_UNREADABLE');
});

test('subscription sessions restore and refresh using encrypted credentials without a second browser login', async t => {
  const { store, path, key } = await setup();
  const p = makeRouterPreset('codex', 'responses');
  const worker = new URL('./fixtures/agent-router-worker.js', import.meta.url);
  const first = new RouterSubscriptions({}, worker, store);
  t.after(() => first.close());
  await store.set(p, { kind: 'subscription', auth: { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: 1, accountId: 'account-1' } });
  await first.models(p); await first.close(); await store.flush();
  const reopened = new RouterCredentialStore(path, key); await reopened.init();
  const second = new RouterSubscriptions({}, worker, reopened); t.after(() => second.close());
  assert.equal(second.ready(p), true); assert.ok((await second.models(p)).includes('gpt-test'));
  const credential = reopened.get(p); assert.equal(credential?.kind, 'subscription');
  const raw = await readFile(path, 'utf8'); assert.equal(raw.includes('fake-device'), false); assert.equal(raw.includes('fake-job'), false);
  const auth = new RouterCredentials({}, Date.now, second, reopened); await auth.logout(p);
  const final = new RouterCredentialStore(path, key); await final.init(); assert.equal(final.get(p), undefined); assert.equal(second.ready(p), false);
});


test('accounts on the same channel keep independent credentials across restart, disable and logout', async () => {
  const { store, path, key } = await setup();
  const first = { ...makeRouterPreset('codex', 'responses'), id: 'codex-personal', name: 'Personal' };
  const second = { ...first, id: 'codex-team', name: 'Team' };
  await store.set(first, { kind: 'subscription', auth: { type: 'oauth', access: 'personal-token' } });
  await store.set(second, { kind: 'subscription', auth: { type: 'oauth', access: 'team-token' } });
  const reopened = new RouterCredentialStore(path, key); await reopened.init();
  assert.deepEqual(reopened.get({ ...first, enabled: false, name: 'Renamed' }), reopened.get(first));
  assert.notDeepEqual(reopened.get(first), reopened.get(second));
  await reopened.delete(first);
  assert.equal(reopened.get(first), undefined);
  assert.deepEqual(reopened.get(second), { kind: 'subscription', auth: { type: 'oauth', access: 'team-token' } });
  const apiFirst = { ...provider, id: 'api-personal' };
  const apiSecond = { ...provider, id: 'api-team' };
  await reopened.set(apiFirst, { kind: 'api', key: 'personal-key' });
  await reopened.set(apiSecond, { kind: 'api', key: 'team-key' });
  const credentials = new RouterCredentials({}, Date.now, undefined, reopened);
  assert.equal(await credentials.resolve(apiFirst), 'personal-key');
  assert.equal(await credentials.resolve(apiSecond), 'team-key');
  await credentials.logout(apiFirst);
  assert.equal(await credentials.resolve(apiSecond), 'team-key');
});

test('native state account identity survives subject-preserving refresh and rejects account replacement', async () => {
  const { store } = await setup(); const p = makeRouterPreset('antigravity');
  const credentials = new RouterCredentials({}, Date.now, undefined, store);
  await store.set(p, { kind: 'subscription', auth: { type: 'oauth', access: 'access-one', refresh: 'refresh-one', uid: 'subject-one', expires: 1 } });
  const first = await credentials.stateIdentity(p);
  await store.set(p, { kind: 'subscription', auth: { type: 'oauth', access: 'access-two', refresh: 'refresh-two', uid: 'subject-one', expires: 2 } });
  assert.equal(await credentials.stateIdentity(p), first);
  await store.set(p, { kind: 'subscription', auth: { type: 'oauth', access: 'access-two', uid: 'subject-two' } });
  assert.notEqual(await credentials.stateIdentity(p), first);
  await store.set(p, { kind: 'subscription', auth: { type: 'oauth', access: 'access-one', uid: 'subject-one' } });
  credentials.forget(p.id); assert.notEqual(await credentials.stateIdentity(p), first);
});

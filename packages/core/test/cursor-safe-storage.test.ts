import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  CursorSafeStorageError,
  configureCursorKeychainPasswordStore,
  isPlainCursorAccessToken,
  isSealedCursorAccessToken,
  resetCursorSafeStorageCache,
  sealCursorAccessTokenForTests,
  sealCursorAccessTokenLinuxForTests,
  sealCursorAccessTokenWindowsForTests,
  unwrapCursorAccessToken,
} from '../src/subscription/readers/cursor-safe-storage.js';

const PASSWORD = 'fixture-cursor-keychain-password';

function jwtFor(sub: string): string {
  return `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
}

function memoryStore(initial: string | null = null) {
  const store = {
    value: initial,
    saves: 0,
    clears: 0,
    async load() { return store.value; },
    async save(password: string) { store.saves += 1; store.value = password; },
    async clear() { store.clears += 1; store.value = null; },
  };
  return store;
}

test.beforeEach(() => {
  configureCursorKeychainPasswordStore(null);
  resetCursorSafeStorageCache();
});

test.after(() => {
  configureCursorKeychainPasswordStore(null);
  resetCursorSafeStorageCache();
});

test('stored password decrypts on a new launch without touching Keychain', async () => {
  const jwt = jwtFor('auth0|user_stored');
  const sealed = sealCursorAccessTokenForTests(jwt, PASSWORD);
  const store = memoryStore();
  configureCursorKeychainPasswordStore(store);
  let keychainReads = 0;
  const readKeychainPassword = async () => { keychainReads += 1; return PASSWORD; };

  assert.equal(
    await unwrapCursorAccessToken(sealed, { platform: 'darwin', allowKeychainPrompt: true, forceKeychainRefresh: true, readKeychainPassword }),
    jwt,
  );
  assert.equal(keychainReads, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.value, PASSWORD);

  resetCursorSafeStorageCache();
  assert.equal(await unwrapCursorAccessToken(sealed, { platform: 'darwin', readKeychainPassword }), jwt);
  assert.equal(
    await unwrapCursorAccessToken(sealed, { platform: 'darwin', allowKeychainPrompt: true, forceKeychainRefresh: true, readKeychainPassword }),
    jwt,
  );
  assert.equal(keychainReads, 1);
  assert.equal(store.saves, 1);
});

test('stale stored password is cleared and auto loads fall back to the refresh hint', async () => {
  const sealed = sealCursorAccessTokenForTests(jwtFor('auth0|user_rotated'), PASSWORD);
  const store = memoryStore('previous-cursor-password');
  configureCursorKeychainPasswordStore(store);
  let keychainReads = 0;

  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      readKeychainPassword: async () => { keychainReads += 1; return PASSWORD; },
    }),
    (error: unknown) => error instanceof CursorSafeStorageError && error.kind === 'keychain-required',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keychainReads, 0);
  assert.equal(store.clears, 1);
  assert.equal(store.value, null);
});

test('denied Keychain access stores nothing', async () => {
  const sealed = sealCursorAccessTokenForTests(jwtFor('auth0|user_denied_store'), PASSWORD);
  const store = memoryStore();
  configureCursorKeychainPasswordStore(store);

  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      allowKeychainPrompt: true,
      readKeychainPassword: async () => { throw new Error('denied'); },
    }),
    (error: unknown) => error instanceof CursorSafeStorageError && error.kind === 'keychain-denied',
  );
  assert.equal(store.saves, 0);
  assert.equal(store.value, null);
});

test('plaintext JWTs pass through unchanged for older Cursor builds', async () => {
  resetCursorSafeStorageCache();
  const jwt = jwtFor('auth0|user_plain');
  assert.equal(isPlainCursorAccessToken(jwt), true);
  assert.equal(isSealedCursorAccessToken(jwt), false);
  assert.equal(await unwrapCursorAccessToken(jwt, { platform: 'darwin' }), jwt);
});

test('CSV sync can skip Keychain while subscription reads may prompt once', async () => {
  resetCursorSafeStorageCache();
  const jwt = jwtFor('auth0|user_sealed');
  const sealed = sealCursorAccessTokenForTests(jwt, PASSWORD);
  assert.equal(isSealedCursorAccessToken(sealed), true);
  assert.match(sealed, /^cursor-safe-storage:v1:/);

  let keychainReads = 0;
  const readPassword = async () => {
    keychainReads += 1;
    return PASSWORD;
  };

  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, { platform: 'darwin', readKeychainPassword: readPassword }),
    (error: unknown) => error instanceof CursorSafeStorageError
      && error.kind === 'keychain-required'
      && /刷新|始终允许/.test(error.message),
  );
  assert.equal(keychainReads, 0);

  const plain = await unwrapCursorAccessToken(sealed, {
    platform: 'darwin',
    allowKeychainPrompt: true,
    readKeychainPassword: readPassword,
  });
  assert.equal(plain, jwt);
  assert.equal(keychainReads, 1);

  // After a successful grant, automatic reads reuse the in-memory cache with no prompt.
  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      readKeychainPassword: readPassword,
    }),
    jwt,
  );
  assert.equal(keychainReads, 1);
});

test('Keychain denial suppresses later auto prompts until a forced refresh', async () => {
  resetCursorSafeStorageCache();
  const { isCursorKeychainDenied } = await import('../src/subscription/readers/cursor-safe-storage.js');
  const jwt = jwtFor('auth0|user_denied');
  const sealed = sealCursorAccessTokenForTests(jwt, PASSWORD);
  let keychainReads = 0;

  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      allowKeychainPrompt: true,
      readKeychainPassword: async () => {
        keychainReads += 1;
        throw new Error('denied');
      },
    }),
    (error: unknown) => error instanceof CursorSafeStorageError && error.kind === 'keychain-denied',
  );
  assert.equal(keychainReads, 1);
  assert.equal(isCursorKeychainDenied(), true);

  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      allowKeychainPrompt: false,
      readKeychainPassword: async () => {
        keychainReads += 1;
        return PASSWORD;
      },
    }),
    (error: unknown) => error instanceof CursorSafeStorageError && error.kind === 'keychain-denied',
  );
  assert.equal(keychainReads, 1);

  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      allowKeychainPrompt: true,
      forceKeychainRefresh: true,
      readKeychainPassword: async () => {
        keychainReads += 1;
        return PASSWORD;
      },
    }),
    jwt,
  );
  assert.equal(keychainReads, 2);
  assert.equal(isCursorKeychainDenied(), false);
});

test('forceKeychainRefresh re-reads the keychain after a failed decrypt cache', async () => {
  resetCursorSafeStorageCache();
  const jwt = jwtFor('auth0|user_refresh');
  const sealed = sealCursorAccessTokenForTests(jwt, PASSWORD);
  let keychainReads = 0;
  const readPassword = async () => {
    keychainReads += 1;
    return keychainReads === 1 ? 'wrong-password' : PASSWORD;
  };

  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      allowKeychainPrompt: true,
      readKeychainPassword: readPassword,
    }),
    (error: unknown) => error instanceof CursorSafeStorageError && error.kind === 'decrypt-failed',
  );
  assert.equal(keychainReads, 1);

  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      allowKeychainPrompt: true,
      readKeychainPassword: readPassword,
      forceKeychainRefresh: true,
    }),
    jwt,
  );
  assert.equal(keychainReads, 2);
});

test('Windows sealed tokens decrypt via OSCrypt AES-256-GCM without Keychain wording', async () => {
  resetCursorSafeStorageCache();
  const jwt = jwtFor('auth0|user_win');
  const key = randomBytes(32);
  const sealed = sealCursorAccessTokenWindowsForTests(jwt, key);
  let keyReads = 0;

  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'win32',
      readWindowsOsCryptKey: async () => {
        keyReads += 1;
        return Buffer.from(key);
      },
    }),
    jwt,
  );
  assert.equal(keyReads, 1);

  // Cached key — no second Local State / DPAPI round-trip.
  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'win32',
      readWindowsOsCryptKey: async () => {
        keyReads += 1;
        return Buffer.from(key);
      },
    }),
    jwt,
  );
  assert.equal(keyReads, 1);
});

test('Linux v10 peanuts decrypts without Secret Service prompt', async () => {
  resetCursorSafeStorageCache();
  const jwt = jwtFor('auth0|user_linux_basic');
  const sealed = sealCursorAccessTokenLinuxForTests(jwt, 'peanuts', 'v10');
  let keyringReads = 0;
  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'linux',
      readLinuxPassword: async () => {
        keyringReads += 1;
        return 'should-not-run';
      },
    }),
    jwt,
  );
  assert.equal(keyringReads, 0);
});

test('Linux v11 requires an explicit refresh before reading the keyring', async () => {
  resetCursorSafeStorageCache();
  const jwt = jwtFor('auth0|user_linux_v11');
  const password = 'linux-keyring-password';
  const sealed = sealCursorAccessTokenLinuxForTests(jwt, password, 'v11');
  let keyringReads = 0;

  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, {
      platform: 'linux',
      readLinuxPassword: async () => {
        keyringReads += 1;
        return password;
      },
    }),
    (error: unknown) => error instanceof CursorSafeStorageError
      && error.kind === 'keychain-required'
      && /钥匙环/.test(error.message)
      && !error.message.includes('钥匙串'),
  );
  assert.equal(keyringReads, 0);

  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'linux',
      allowKeychainPrompt: true,
      readLinuxPassword: async () => {
        keyringReads += 1;
        return password;
      },
    }),
    jwt,
  );
  assert.equal(keyringReads, 1);
});

test('decryptString override still works on any platform', async () => {
  resetCursorSafeStorageCache();
  const jwt = jwtFor('auth0|user_override');
  const sealed = sealCursorAccessTokenForTests(jwt, PASSWORD);
  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'win32',
      decryptString: () => jwt,
    }),
    jwt,
  );
});

test('malformed sealed payloads surface a structured error', async () => {
  resetCursorSafeStorageCache();
  await assert.rejects(
    () => unwrapCursorAccessToken('cursor-safe-storage:v1:@@@', { platform: 'darwin' }),
    (error: unknown) => error instanceof CursorSafeStorageError && error.kind === 'malformed',
  );
  await assert.rejects(
    () => unwrapCursorAccessToken('not-a-token', { platform: 'darwin' }),
    (error: unknown) => error instanceof CursorSafeStorageError && error.kind === 'malformed',
  );
});

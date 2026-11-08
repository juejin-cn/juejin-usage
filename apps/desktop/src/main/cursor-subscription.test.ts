import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCursorSessionCookie, extractCursorUserId } from './cursor-subscription';

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('extracts the Cursor user id from common JWT subjects', () => {
  assert.equal(extractCursorUserId(jwt({ sub: 'auth0|user_abc123' })), 'user_abc123');
  assert.equal(extractCursorUserId(jwt({ sub: 'google-oauth2|person-id' })), 'google-oauth2|person-id');
  assert.equal(extractCursorUserId('invalid'), null);
});

test('encodes the Cursor dashboard session cookie', () => {
  assert.equal(
    buildCursorSessionCookie('auth0|user', 'a.b-c_d'),
    'WorkosCursorSessionToken=auth0|user%3A%3Aa.b-c_d',
  );
});

test('desktop session user id prefers the JWT subject over CLI authId', () => {
  const token = jwt({ sub: 'auth0|user_live' });
  assert.equal(extractCursorUserId(token), 'user_live');
  assert.equal(extractCursorUserId(token) ?? 'auth0|user_stale', 'user_live');
});

test('fetches Auto/API and Grok Bot with the same account while keeping reset periods separate', async () => {
  const { fetchCursorSubscription } = await import('./cursor-subscription.js');
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('usage-summary')) {
      return Response.json({
        billingCycleEnd: '2026-11-01T00:00:00Z', membershipType: 'pro',
        individualUsage: { plan: { autoPercentUsed: 20, apiPercentUsed: 40 } },
      });
    }
    if (url.endsWith('get-plan-info')) {
      return Response.json({ planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY' } });
    }
    return Response.json({ includedLimitZero: false, usagePercent: 70, nextResetTimestampUtc: '2026-10-08T00:00:00Z' });
  }) as typeof fetch;
  const snapshot = await fetchCursorSubscription({ userId: 'test-user', token: 'test-token' }, fetchImpl);
  assert.equal(snapshot.hasAccount, true);
  assert.equal(snapshot.cursorModels?.usedPercent, 20);
  assert.equal(snapshot.otherModels?.usedPercent, 40);
  assert.equal(snapshot.grokBot?.usedPercent, 70);
  assert.notEqual(snapshot.cursorModels?.resetsAt, snapshot.grokBot?.resetsAt);
  assert.equal(calls.length, 3);
  const bot = calls.find(({ url }) => url.endsWith('get-sand-usage-status'))!;
  assert.equal(bot.init?.method, 'POST');
  assert.equal(bot.init?.body, '{}');
  for (const { init } of calls) assert.equal(new Headers(init?.headers).get('Cookie'), buildCursorSessionCookie('test-user', 'test-token'));
});

test('optional Grok Bot failures do not hide valid Cursor pools', async () => {
  const { fetchCursorSubscription } = await import('./cursor-subscription.js');
  for (const failure of ['network', 'auth', 'malformed', 'no-entitlement']) {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('usage-summary')) return Response.json({ individualUsage: { plan: { autoPercentUsed: 20 } } });
      if (url.endsWith('get-plan-info')) return Response.json({ planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY' } });
      if (url.endsWith('get-sand-usage-status')) {
        if (failure === 'network') throw new Error('timeout');
        if (failure === 'auth') return new Response('', { status: 403 });
        if (failure === 'malformed') return new Response('invalid json');
        return Response.json({ includedLimitZero: true, usagePercent: 0 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const snapshot = await fetchCursorSubscription({ userId: 'test-user', token: 'test-token' }, fetchImpl);
    assert.equal(snapshot.status, 'ready', failure);
    assert.equal(snapshot.cursorModels?.usedPercent, 20, failure);
    assert.equal(snapshot.grokBot, undefined, failure);
  }
});

test('weekly Premium plans replace misleading zero Auto/API pools', async () => {
  const { fetchCursorSubscription } = await import('./cursor-subscription.js');
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('usage-summary')) {
      return Response.json({
        membershipType: 'premium',
        individualUsage: { plan: { autoPercentUsed: 0, apiPercentUsed: 0 } },
      });
    }
    if (url.endsWith('get-plan-info')) {
      return Response.json({ planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY' } });
    }
    if (url.endsWith('get-current-period-usage')) {
      return Response.json({
        billingCycleStart: '2026-10-01T00:00:00Z',
        billingCycleEnd: '2026-10-08T00:00:00Z',
        planUsage: { totalPercentUsed: 35.5 },
      });
    }
    if (url.endsWith('get-sand-usage-status')) return new Response('', { status: 404 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const snapshot = await fetchCursorSubscription({ userId: 'test-user', token: 'test-token' }, fetchImpl);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.hasAccount, true);
  assert.equal(snapshot.planLabel, 'Premium');
  assert.equal(snapshot.cursorModels, null);
  assert.equal(snapshot.otherModels, null);
  assert.deepEqual(snapshot.plan, { usedPercent: 35.5, startsAt: 1_790_812_800, resetsAt: 1_791_417_600 });
});

test('first open without a stored password does not force a Keychain dialog', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const {
    readCursorSubscription,
    configureCursorSubscriptionReader,
    sealCursorAccessTokenForTests,
    resetCursorSafeStorageCache,
    isCursorKeychainDenied,
  } = await import('./cursor-subscription.js');

  resetCursorSafeStorageCache();
  const directory = await mkdtemp(join(tmpdir(), 'jusage-cursor-has-account-'));
  const db = join(directory, 'state.vscdb');
  const jwt = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|user_visible' })).toString('base64url')}.sig`;
  const sealed = sealCursorAccessTokenForTests(jwt, 'fixture-password');
  const stateDb = new DatabaseSync(db);
  stateDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  stateDb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', sealed);
  stateDb.close();
  const previousDb = process.env.CURSOR_STATE_DB_PATH;
  process.env.CURSOR_STATE_DB_PATH = db;
  let keychainReads = 0;
  configureCursorSubscriptionReader({
    platform: 'darwin',
    readKeychainPassword: async () => {
      keychainReads += 1;
      throw new Error('user denied');
    },
  });
  try {
    const snapshot = await readCursorSubscription({ forceRefresh: false });
    assert.equal(snapshot.status, 'temporarily-unavailable');
    assert.equal(snapshot.hasAccount, true);
    assert.equal(keychainReads, 0);
    assert.equal(isCursorKeychainDenied(), false);
    assert.match(snapshot.message ?? '', /刷新|始终允许/);

    const denied = await readCursorSubscription({ forceRefresh: true });
    assert.equal(denied.hasAccount, true);
    assert.equal(keychainReads, 1);
    assert.equal(isCursorKeychainDenied(), true);
    assert.match(denied.message ?? '', /刷新|始终允许/);

    // After denial, auto open must still not re-prompt.
    const again = await readCursorSubscription({ forceRefresh: false });
    assert.equal(again.hasAccount, true);
    assert.equal(keychainReads, 1);
  } finally {
    configureCursorSubscriptionReader({});
    if (previousDb === undefined) delete process.env.CURSOR_STATE_DB_PATH;
    else process.env.CURSOR_STATE_DB_PATH = previousDb;
    resetCursorSafeStorageCache();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a password stored by an earlier session lets auto open load without Keychain', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const {
    readCursorSubscription,
    configureCursorSubscriptionReader,
    configureCursorKeychainPasswordStore,
    sealCursorAccessTokenForTests,
    resetCursorSafeStorageCache,
  } = await import('./cursor-subscription.js');

  resetCursorSafeStorageCache();
  const directory = await mkdtemp(join(tmpdir(), 'jusage-cursor-stored-password-'));
  const db = join(directory, 'state.vscdb');
  const password = 'fixture-stored-password';
  const jwt = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|user_open' })).toString('base64url')}.sig`;
  const sealed = sealCursorAccessTokenForTests(jwt, password);
  const stateDb = new DatabaseSync(db);
  stateDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  stateDb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', sealed);
  stateDb.close();
  const previousDb = process.env.CURSOR_STATE_DB_PATH;
  process.env.CURSOR_STATE_DB_PATH = db;
  configureCursorKeychainPasswordStore({
    load: async () => password,
    save: async () => {},
    clear: async () => {},
  });
  let keychainReads = 0;
  configureCursorSubscriptionReader({
    platform: 'darwin',
    readKeychainPassword: async () => {
      keychainReads += 1;
      return password;
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('usage-summary')) {
      return Response.json({
        membershipType: 'pro',
        individualUsage: { plan: { autoPercentUsed: 10, apiPercentUsed: 0 } },
      });
    }
    if (url.endsWith('get-plan-info')) {
      return Response.json({ planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY' } });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    const autoOpen = await readCursorSubscription({ forceRefresh: false });
    assert.equal(keychainReads, 0);
    assert.equal(autoOpen.status, 'ready');
    assert.equal(autoOpen.hasAccount, true);
    assert.equal(autoOpen.message, null);

    const refreshed = await readCursorSubscription({ forceRefresh: true });
    assert.equal(keychainReads, 0);
    assert.equal(refreshed.status, 'ready');
  } finally {
    globalThis.fetch = originalFetch;
    configureCursorSubscriptionReader({});
    configureCursorKeychainPasswordStore(null);
    if (previousDb === undefined) delete process.env.CURSOR_STATE_DB_PATH;
    else process.env.CURSOR_STATE_DB_PATH = previousDb;
    resetCursorSafeStorageCache();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sealed Cursor access tokens decrypt with the macOS os_crypt scheme', async () => {
  const {
    sealCursorAccessTokenForTests,
    unwrapCursorAccessToken,
    resetCursorSafeStorageCache,
    isSealedCursorAccessToken,
    isPlainCursorAccessToken,
  } = await import('./cursor-subscription.js');
  resetCursorSafeStorageCache();
  const password = 'fixture-cursor-keychain-password';
  const jwt = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|user_sealed' })).toString('base64url')}.sig`;
  assert.equal(isPlainCursorAccessToken(jwt), true);
  const sealed = sealCursorAccessTokenForTests(jwt, password);
  assert.equal(isSealedCursorAccessToken(sealed), true);
  assert.equal(isPlainCursorAccessToken(sealed), false);
  await assert.rejects(
    () => unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      readKeychainPassword: async () => password,
    }),
    (error: unknown) => error instanceof Error && error.message.includes('点击刷新'),
  );
  assert.equal(
    await unwrapCursorAccessToken(sealed, {
      platform: 'darwin',
      allowKeychainPrompt: true,
      readKeychainPassword: async () => password,
    }),
    jwt,
  );
  assert.equal(await unwrapCursorAccessToken(jwt, { platform: 'darwin' }), jwt);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { prependGuiNodePaths } from './cli-runtime';

test('adds GUI-safe Node locations ahead of Finder PATH without removing it', {
  skip: process.platform !== 'darwin',
}, () => {
  const result = prependGuiNodePaths('/usr/bin:/bin', '/Users/tester');
  const entries = result.split(path.delimiter);
  assert.ok(entries.indexOf('/opt/homebrew/bin') < entries.indexOf('/usr/bin'));
  assert.ok(entries.includes('/usr/local/bin'));
  assert.ok(entries.indexOf('/Users/tester/Library/pnpm/bin') < entries.indexOf('/usr/bin'));
  assert.deepEqual(entries.slice(-2), ['/usr/bin', '/bin']);
});


import { createCodexSubscriptionReader, mapCodexUsage, parseCodexCredentials } from './codex-subscription';
const jwt = (data: object) => `header.${Buffer.from(JSON.stringify(data)).toString('base64url')}.signature`;
const auth = (account = 'one', expiry = 2000000000) => JSON.stringify({
  auth_mode: 'chatgpt', tokens: { account_id: account, access_token: jwt({ exp: expiry }), id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fallback', chatgpt_plan_type: 'plus' } }) },
});
const payload = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1800000000 }, secondary_window: { used_percent: 34, limit_window_seconds: 604800 } } };
test('reads reset card counts from the usage response, preserving zero and rejecting invalid counts', () => {
  for (const count of [0, 2, '2']) {
    assert.deepEqual(mapCodexUsage({ rate_limit_reset_credits: { available_count: count, secret: 'hidden' } }).resetCredits, { availableCount: Number(count) });
  }
  for (const count of [null, undefined, '', false, -1, 1.5, Infinity, NaN]) {
    assert.equal(mapCodexUsage({ rate_limit_reset_credits: { available_count: count } }).resetCredits, undefined);
  }
  assert.equal(mapCodexUsage({}).resetCredits, undefined);
});

test('passes real reset card counts through the subscription reader', async () => {
  const read = createCodexSubscriptionReader({ readAuth: async () => auth(), now: () => 1800000000000,
    fetch: async () => Response.json({ ...payload, rate_limit_reset_credits: { available_count: 2 } }),
  });
  assert.deepEqual((await read()).resetCredits, { availableCount: 2 });
});
test('maps wham windows without inventing missing percentages', () => {
  assert.equal(mapCodexUsage(payload).fiveHour?.usedPercent, 12);
  assert.equal(mapCodexUsage(payload).weekly?.usedPercent, 34);
  assert.equal(mapCodexUsage({ rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 18000 } } }).fiveHour, null);
  assert.equal(mapCodexUsage({}).weekly, null);
  const parsed = parseCodexCredentials({ tokens: { access_token: 'opaque', id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fallback' } }) } });
  assert.equal(parsed.accountId, 'fallback');
  assert.equal(parsed.expiresAt, null);
});
test('direct request authenticates, merges callers, isolates changed credentials and never exposes tokens', async () => {
  let raw = auth(), calls = 0;
  const read = createCodexSubscriptionReader({ readAuth: async () => raw, now: () => 1800000000000,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal((options?.headers as Record<string,string>)['ChatGPT-Account-Id'], JSON.parse(raw).tokens.account_id);
      assert.match((options?.headers as Record<string,string>).Authorization, /^Bearer /);
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return Response.json(payload);
    },
  });
  const results = await Promise.all([read(), read(), read()]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'ready');
  assert.equal(JSON.stringify(results).includes('signature'), false);
  await read(); assert.equal(calls, 1);
  raw = auth('two'); await read(); assert.equal(calls, 2);
  raw = '{}'; assert.equal((await read()).status, 'not-signed-in');
});
test('temporary failures retain only same-account success; refusal clears old data', async () => {
  let now = 1800000000000, status = 200, raw = auth();
  const read = createCodexSubscriptionReader({ readAuth: async () => raw, now: () => now, fetch: async () => status === 200 ? Response.json(payload) : new Response('', { status }) });
  await read(); now += 61000; status = 429;
  assert.equal((await read()).stale, true);
  now += 61000; status = 401;
  const expired = await read(); assert.equal(expired.status, 'expired'); assert.equal(expired.fiveHour, null); assert.equal(expired.hasAccount, true);
  raw = auth('two'); status = 503;
  assert.equal((await read()).fiveHour, null);
  now += 61000; status = 403;
  assert.equal((await read()).status, 'access-denied');
});
test('missing, malformed, expired and API-key credentials never make a request', async () => {
  for (const raw of ['{broken', '{}', auth('one', 1), '{"auth_mode":"apikey"}']) {
    const read = createCodexSubscriptionReader({ readAuth: async () => raw, now: () => 1800000000000, fetch: async () => { assert.fail('must not request'); } });
    assert.notEqual((await read()).status, 'ready');
  }
  const read = createCodexSubscriptionReader({ readAuth: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, fetch });
  assert.equal((await read()).hasAccount, false);
});
test('invalid response and abort return a bounded unavailable snapshot', async () => {
  for (const request of [async () => Response.json({}), async () => { throw new DOMException('timeout', 'TimeoutError'); }]) {
    const read = createCodexSubscriptionReader({ readAuth: async () => auth(), now: () => 1800000000000, fetch: request });
    assert.equal((await read()).status, 'unavailable');
  }
});

test('a late reading from the previous account cannot overwrite the current cache', async () => {
  let raw = auth('one'), release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = createCodexSubscriptionReader({ now: () => 1800000000000, readAuth: async () => raw,
    fetch: async (_url, options) => {
      if ((options?.headers as Record<string,string>)['ChatGPT-Account-Id'] === 'one') await gate;
      return Response.json(payload);
    },
  });
  const first = read();
  await new Promise(resolve => setImmediate(resolve));
  raw = auth('two');
  const second = await read();
  release?.(); await first;
  assert.equal(await read(), second);
});

test('explicit retry bypasses cached server and network failures', async () => {
  for (const failure of [
    () => new Response('', { status: 503 }),
    () => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); },
  ]) {
    let failing = true, calls = 0;
    const read = createCodexSubscriptionReader({ readAuth: async () => auth(), now: () => 1800000000000,
      fetch: async () => { calls++; return failing ? failure() : Response.json(payload); },
    });
    assert.equal((await read()).status, 'unavailable');
    failing = false;
    assert.equal((await read()).status, 'unavailable');
    const recovered = await read({ forceRefresh: true });
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.fiveHour?.usedPercent, 12);
    assert.equal(recovered.stale, false);
    assert.equal(calls, 2);
  }
});

import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { decodeTraeAuth, parseTraeAccount, readTraeAccount, traeAccountRequest, TRAE_USAGE_COLLECTOR } from '../src/parsers/trae-account.js';
import { fetchTraeUsage, traeUsageBuckets } from '../src/parsers/trae-usage.js';
import { syncTraeApi, replaceTraeSnapshot } from '../src/sync/trae-api.js';
import { readTraeGlobalSubscription } from '../src/subscription/readers/trae-subscription.js';
import { mapTraeGlobalEntitlements } from '../src/subscription/shared/trae-subscription.js';
import { aggregateForIngest } from '../src/aggregate.js';
import { bucketToIngestEvent } from '../src/upload/events.js';
import { computeRowCost, computeTokens } from '../src/pricing/index.js';
import { appendBuckets, loadBucketsForRange } from '../src/queue/index.js';

const now = Date.parse('2026-11-05T12:00:00Z'), since = '2026-11-01T00:00:00.000Z';
const session = (id = 'session-1', prompt = 1000) => ({ session_id: id, model_name: 'Claude Sonnet 4.5', usage_time: now / 1000 - 3600, dollar_float: 0.2,
  extra_info: { input_token: prompt, output_token: 20, cache_read_token: 100, cache_write_token: 0 } });
const auth = { token: 'fixture-trae-token-never-a-real-secret', userId: 'fixture-account', region: 'sg' };
const account = parseTraeAccount(auth)!;
const quota = { user_entitlement_pack_list: [{ entitlement_base_info: { product_type: 1, end_time: 2_000_000_000, product_extra: { subscription_extra: { quota: { basic_usage_limit: 20, bonus_usage_limit: 5 } } } }, usage: { basic_usage_amount: 4, bonus_usage_amount: 1 } }] };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'jusage-trae-api-'));
  const home = join(directory, 'trae'), storage = join(home, 'User', 'globalStorage', 'storage.json');
  await mkdir(join(home, 'User', 'globalStorage'), { recursive: true });
  const saved = process.env.TRAE_HOME;
  process.env.TRAE_HOME = home;
  t.after(async () => { if (saved === undefined) delete process.env.TRAE_HOME; else process.env.TRAE_HOME = saved; await rm(directory, { recursive: true, force: true }); });
  const login = async (value: unknown) => writeFile(storage, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': value }));
  await login(auth);
  return { directory, login, storage };
}

test('Trae login accepts canonical JSON and rejects unrelated API keys and corrupt ciphertext', () => {
  assert.equal(parseTraeAccount(JSON.stringify(auth))?.identity, account.identity);
  assert.equal(parseTraeAccount({ ...auth, token: 'rotated-fixture-token-long-enough' })?.identity, account.identity);
  assert.notEqual(parseTraeAccount({ ...auth, userId: 'other-account' })?.identity, account.identity);
  assert.equal(parseTraeAccount({ apiKey: auth.token }), null);
  assert.throws(() => decodeTraeAuth(Buffer.alloc(118).toString('base64')));
  assert.throws(() => parseTraeAccount({ ...auth, region: 'cn' }));
  assert.equal(parseTraeAccount({ ...auth, region: 'us' })?.origin, 'https://api-us-east.trae.ai');
  assert.equal(parseTraeAccount({ ...auth, userRegion: { region: 'SG', _aiRegion: 'US' } })?.origin, 'https://api-us-east.trae.ai');
  assert.equal(parseTraeAccount({ ...auth, account: { uidRegion: 'US' } })?.origin, 'https://api-us-east.trae.ai');
  assert.equal(parseTraeAccount({ ...auth, aiRegion: 'US' })?.origin, 'https://api-us-east.trae.ai');
  assert.throws(() => parseTraeAccount({ ...auth, userRegion: { _aiRegion: 'CN' } }), /REGION_UNSUPPORTED/);
});

test('Trae byteCrypto login verifies the SHA-512 prefix and never modifies IDE files', async t => {
  // Independent fixture using the published byteCrypto wire constants.
  const password = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const salt = Buffer.alloc(32, 0xaa), material = createHash('sha512').update(createHash('sha512').update(salt).digest()).update(password).digest();
  const data = Buffer.from(JSON.stringify(auth));
  const cipher = createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const encrypted = Buffer.concat([Buffer.from([116, 99, 5, 16, 0, 0]), salt, cipher.update(Buffer.concat([createHash('sha512').update(data).digest(), data])), cipher.final()]);
  assert.deepEqual(decodeTraeAuth(encrypted.toString('base64')), auth);
  encrypted[45] = encrypted[45]! ^ 1;
  assert.throws(() => decodeTraeAuth(encrypted.toString('base64')));
  const { storage, login } = await fixture(t);
  await login(encrypted.toString('base64'));
  // Restore the valid envelope after checking the tampered one.
  encrypted[45] = encrypted[45]! ^ 1;
  await login(encrypted.toString('base64'));
  const original = await readFile(storage, 'utf8');
  assert.equal((await readTraeAccount())?.identity, account.identity);
  assert.equal(await readFile(storage, 'utf8'), original);
});

test('usage normalizes cached input without double counting, keeps vendor cost, and does not invent requests', () => {
  const [row] = traeUsageBuckets([session(), session()], Date.parse(since) / 1000, now / 1000);
  assert.equal(row!.total_tokens, 1020); assert.equal(computeTokens(row!), 1020);
  assert.equal(row!.input_tokens, 900); assert.equal(row!.cached_input_tokens, 100);
  assert.equal(row!.conversation_count, 0); assert.equal(row!.local_metrics?.requestCountComplete, false);
  assert.equal(computeRowCost(row!), 0.2); assert.equal(computeRowCost({ ...row!, reported_cost_usd: 0 }), 0);
  assert.equal(aggregateForIngest([row!]).length, 0);
  assert.equal(bucketToIngestEvent(row!, 'device'), null);
  assert.equal(row!.project, 'unknown'); assert.equal(row!.collector, TRAE_USAGE_COLLECTOR);
  const write = session(); write.extra_info.cache_write_token = 1;
  assert.throws(() => traeUsageBuckets([write], 0, now / 1000), /UNVERIFIED/);
  const invalid = session(); invalid.extra_info.input_token = -1;
  assert.throws(() => traeUsageBuckets([invalid], 0, now / 1000), /FORMAT/);
});

test('Trae pagination continues without total, authenticates only to the billing region, and rejects partial snapshots', async () => {
  let calls = 0;
  const rows = await fetchTraeUsage(account, since, { now, pageDelayMs: 0, fetcher: async (input, init) => {
    assert.match(String(input), /^https:\/\/api-sg-central\.trae\.ai\//);
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('Authorization'), `Cloud-IDE-JWT ${auth.token}`);
    const request = JSON.parse(String(init?.body)); assert.equal(request.page_size, 20); assert.equal(request.page_num, ++calls); assert.deepEqual(request.usage_type, [5, 6]);
    return Response.json({ user_usage_group_by_sessions: calls <= 2 ? [session(`session-${calls}`)] : [] });
  } });
  assert.equal(calls, 3); assert.equal(rows[0]!.total_tokens, 2040);
  await assert.rejects(fetchTraeUsage(account, since, { now, pageDelayMs: 0, fetcher: async () => Response.json({ total: 5, user_usage_group_by_sessions: [] }) }), /INCOMPLETE/);
  await assert.rejects(fetchTraeUsage(account, since, { now, pageDelayMs: 0, fetcher: async () => Response.json({ user_usage_group_by_sessions: [session()] }) }), /STALLED/);
  await assert.rejects(traeAccountRequest(account, 'user_current_entitlement_list', {}, async () => new Response('', { status: 401 })), /AUTH_EXPIRED/);
  await assert.rejects(traeAccountRequest(account, 'user_current_entitlement_list', {}, async () => Response.json({ code: 403 })), /AUTH_EXPIRED/);
});

test('absolute snapshots retract moved/removed buckets and replace legacy global rows while preserving CN', () => {
  const rows = traeUsageBuckets([session()], 0, now / 1000);
  const cn = { ...rows[0]!, collector: 'trae-cn-ide' }, legacy = { ...rows[0]!, collector: 'trae-ide' };
  const changes = replaceTraeSnapshot([...rows, cn, legacy], [], since);
  assert.equal(changes.length, 2); assert.ok(changes.every(row => row.total_tokens === 0));
  assert.deepEqual(replaceTraeSnapshot(rows, rows, since), []);
});

test('quota maps actual plan independently from basic/bonus and ignores unsupported old counting quotas', () => {
  const mapped = mapTraeGlobalEntitlements(quota, now);
  assert.equal(mapped.planLabel, 'Pro'); assert.equal(mapped.limits[0]!.usedPercent, 20);
  assert.deepEqual(mapped.limits.map(row => row.label), ['基础额度', '奖励额度']);
  assert.equal(mapTraeGlobalEntitlements({ user_entitlement_pack_list: [{ entitlement_base_info: { product_type: 2 } }] }, now).planLabel, null);
  assert.throws(() => mapTraeGlobalEntitlements({}), /FORMAT/);
});

test('sync persists replaceable snapshots, throttles polls, preserves failures, and replays without duplication', async t => {
  const { directory } = await fixture(t);
  let calls = 0, fail = false;
  t.mock.method(globalThis, 'fetch', async () => { calls++; if (fail) throw new Error('fixture outage'); return Response.json({ user_usage_group_by_sessions: [session()], total: 1 }); });
  const [old] = traeUsageBuckets([session()], 0, now / 1000);
  await appendBuckets(directory, [{ ...old!, collector: 'trae-ide' }]);
  const first = await syncTraeApi(directory, since, 60_000);
  assert.equal(first.ownsGlobal, true); assert.equal(first.result.bucketsWritten, 2);
  await syncTraeApi(directory, since, 60_000); assert.equal(calls, 1);
  assert.equal((await syncTraeApi(directory, since)).result.bucketsWritten, 0);
  fail = true; const bad = await syncTraeApi(directory, since);
  assert.ok(bad.result.error); assert.equal(bad.result.bucketsWritten, 0);
  const queued = await loadBucketsForRange(directory, since);
  assert.equal(queued.reduce((sum, row) => sum + computeTokens(row), 0), 1020);
  assert.ok(!(await readFile(join(directory, 'trae-usage-state.json'), 'utf8')).includes(auth.token));
});

test('subscription cache is account-scoped, preserves transient failures, and clears on expiry/logout', async t => {
  const { login } = await fixture(t);
  let status = 200;
  t.mock.method(globalThis, 'fetch', async () => Response.json(quota, { status }));
  assert.equal((await readTraeGlobalSubscription({ forceRefresh: true })).planLabel, 'Pro');
  status = 503;
  assert.equal((await readTraeGlobalSubscription({ forceRefresh: true })).stale, true);
  await login({ ...auth, userId: 'different-account' });
  assert.equal((await readTraeGlobalSubscription({ forceRefresh: true })).limits.length, 0);
  status = 401;
  assert.equal((await readTraeGlobalSubscription({ forceRefresh: true })).status, 'expired');
  await login({});
  assert.equal((await readTraeGlobalSubscription()).status, 'not-signed-in');
});


test('account switches retract old history only after complete success, even after parser cursors are cleared', async t => {
  const { directory, login } = await fixture(t);
  let available = true, prompt = 1000;
  t.mock.method(globalThis, 'fetch', async () => {
    if (!available) throw new Error('offline');
    return Response.json({total:1,user_usage_group_by_sessions:[session('session',prompt)]});
  });
  await syncTraeApi(directory, since);
  await login({...auth,userId:'replacement-account'});
  available = false;
  assert.ok((await syncTraeApi(directory, since)).result.error);
  available = true; prompt = 2000;
  await syncTraeApi(directory, since);
  const rows = await loadBucketsForRange(directory, since);
  assert.equal(rows.reduce((sum,row)=>sum+computeTokens(row),0),2020);
  // A new process or a range reset uses persisted account/backoff state.
  assert.equal((await syncTraeApi(directory, since,60_000)).result.skipped,true);
});

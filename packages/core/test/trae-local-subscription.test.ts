import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { decodeTraeAuth, parseTraeAccount, readTraeAccount, traeAccountRequest } from '../src/parsers/trae-account.js';
import { createTraeSubscriptionReader } from '../src/subscription/readers/trae-subscription.js';
import { mapTraeCnEntitlements, mapTraeGlobalEntitlements } from '../src/subscription/shared/trae-subscription.js';
import { createSubscriptionApi } from '../src/server/subscription-api.js';
import type { readSubscription } from '../src/subscription/read.js';

const auth = { token: 'fixture-trae-token-never-a-real-secret', userId: 'fixture-account', region: 'cn' };
const now = Date.parse('2026-11-11T00:00:00Z');
const pack = (total: number, used?: number, extra: object = {}) => ({ entitlement_base_info: { product_type: 2, end_time: 2_000_000_000, quota: { credits_limit: total }, ...extra }, usage: used === undefined ? {} : { credits_amount: used } });
const quota = { user_entitlement_pack_list: [pack(500, 1.3848), pack(100)] };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'jusage-trae-local-'));
  const oldCn = process.env.TRAE_CN_HOME, oldGlobal = process.env.TRAE_HOME;
  const cn = join(directory, 'cn'), global = join(directory, 'global');
  process.env.TRAE_CN_HOME = cn; process.env.TRAE_HOME = global;
  for (const dir of [cn, global]) await mkdir(join(dir, 'User/globalStorage'), { recursive: true });
  const storage = join(cn, 'User/globalStorage/storage.json');
  const login = async (value: unknown) => writeFile(storage, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': value }));
  await login(auth);
  t.after(async () => {
    if (oldCn === undefined) delete process.env.TRAE_CN_HOME; else process.env.TRAE_CN_HOME = oldCn;
    if (oldGlobal === undefined) delete process.env.TRAE_HOME; else process.env.TRAE_HOME = oldGlobal;
    await rm(directory, { recursive: true, force: true });
  });
  return { storage, login, global };
}

test('local login editions and global billing residency stay isolated', async t => {
  await fixture(t);
  assert.equal((await readTraeAccount('mainland'))?.origin, 'https://api.trae.cn');
  assert.equal(await readTraeAccount(), null);
  assert.equal(parseTraeAccount({ ...auth, region: 'sg', userRegion: { _aiRegion: 'US' } })?.origin, 'https://api-us-east.trae.ai');
  assert.throws(() => parseTraeAccount(auth), /REGION_UNSUPPORTED/);
  assert.throws(() => parseTraeAccount({ ...auth, region: 'us' }, 'mainland'), /REGION_UNSUPPORTED/);
  assert.equal(parseTraeAccount({ apiKey: auth.token }, 'mainland'), null);
});

test('byteCrypto login is verified and read without modifying the IDE file', async t => {
  const { storage, login } = await fixture(t);
  const password = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const salt = Buffer.alloc(32, 0xaa), material = createHash('sha512').update(createHash('sha512').update(salt).digest()).update(password).digest();
  const data = Buffer.from(JSON.stringify(auth)), cipher = createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const encrypted = Buffer.concat([Buffer.from([116, 99, 5, 16, 0, 0]), salt, cipher.update(Buffer.concat([createHash('sha512').update(data).digest(), data])), cipher.final()]);
  await login(encrypted.toString('base64'));
  const original = await readFile(storage, 'utf8');
  assert.deepEqual(decodeTraeAuth(encrypted.toString('base64')), auth);
  assert.ok(await readTraeAccount('mainland'));
  assert.equal(await readFile(storage, 'utf8'), original);
  encrypted[45] = encrypted[45]! ^ 1;
  assert.throws(() => decodeTraeAuth(encrypted.toString('base64')));
});

test('CN quota uses only the official v2 endpoint and local session authentication', async t => {
  await fixture(t);
  const reader = createTraeSubscriptionReader('mainland', async (url, init) => {
    assert.equal(String(url), 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Cloud-IDE-JWT ${auth.token}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { require_usage: true, req_source: 0 });
    return Response.json(quota);
  });
  const result = await reader();
  assert.equal(result.status, 'ready');
  assert.equal(result.limits.length, 2);
  assert.equal(result.limits[0]!.amounts.unit, 'credits');
  assert.ok(!JSON.stringify(result).includes(auth.token));
  await assert.rejects(traeAccountRequest({ token: auth.token, identity: 'x', origin: 'https://example.com' }, 'ide_user_ent_usage', {}, async () => { throw new Error('must not request'); }), /REGION_UNSUPPORTED/);
});

test('global reader preserves the previous API, USD packs and local SG/US account routing', async t => {
  const { global } = await fixture(t);
  await writeFile(join(global, 'User/globalStorage/storage.json'), JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': { ...auth, region: 'us' } }));
  const reader = createTraeSubscriptionReader('global', async (url, init) => {
    assert.equal(String(url), 'https://api-us-east.trae.ai/trae/api/v1/pay/user_current_entitlement_list');
    assert.deepEqual(JSON.parse(String(init?.body)), { require_usage: true, full_data: true });
    return Response.json({ user_entitlement_pack_list: [{ entitlement_base_info: { product_type: 1, product_extra: { subscription_extra: { quota: { basic_usage_limit: 20 } } } }, usage: { basic_usage_amount: 4 } }] });
  });
  const result = await reader();
  assert.equal(result.status, 'ready');
  assert.equal(result.planLabel, 'Pro');
  assert.deepEqual(result.limits[0]!.amounts, { total: 20, used: 4, unit: 'USD' });
});

test('CN packs preserve zero, unlimited and missing usage; expired or hidden packs are excluded', () => {
  const result = mapTraeCnEntitlements({ user_entitlement_pack_list: [...quota.user_entitlement_pack_list, pack(0), pack(-1), pack(50, 0, { end_time: 1 }), { ...pack(30), is_hide: true }, pack(-2), pack(5, -1)] }, now);
  assert.equal(result.limits.length, 4);
  assert.equal(result.limits[1]!.amounts.used, 0);
  assert.equal(result.limits[2]!.amounts.total, 0);
  assert.equal(result.limits[3]!.unlimited, true);
  assert.equal(result.limits[3]!.amounts.total, undefined);
  assert.throws(() => mapTraeCnEntitlements({}), /FORMAT/);
  assert.throws(() => mapTraeGlobalEntitlements({}), /FORMAT/);
});

test('cache cannot carry quotas across account switches or sign-out; refresh failures may retain same-account data', async t => {
  const { login } = await fixture(t);
  let failed = false, calls = 0;
  const reader = createTraeSubscriptionReader('mainland', async () => { calls++; if (failed) throw new Error('network'); return Response.json(quota); });
  assert.equal((await reader()).status, 'ready');
  await reader(); assert.equal(calls, 1);
  failed = true;
  assert.equal((await reader({ forceRefresh: true })).stale, true);
  await login({ ...auth, userId: 'different' });
  const switched = await reader();
  assert.equal(switched.status, 'temporarily-unavailable'); assert.deepEqual(switched.limits, []);
  await login({});
  assert.equal((await reader()).status, 'not-signed-in');
});

test('expiry, business errors and sign-out during a request never become usable quota', async t => {
  const { login } = await fixture(t);
  for (const response of [() => Response.json({}, { status: 401 }), () => Response.json({ code: 20101 })]) {
    assert.equal((await createTraeSubscriptionReader('mainland', async () => response())()).status, 'expired');
  }
  assert.equal((await createTraeSubscriptionReader('mainland', async () => Response.json({ code: 500 }))()).status, 'temporarily-unavailable');
  const changed = await createTraeSubscriptionReader('mainland', async () => { await login({}); return Response.json(quota); })();
  assert.equal(changed.status, 'not-signed-in'); assert.deepEqual(changed.limits, []);
});

test('shared local subscription API accepts both Trae channels and forwards force refresh', async () => {
  const calls: unknown[] = [];
  const api = createSubscriptionApi((async (channel, options) => { calls.push([channel, options]); return { status: 'ready', limits: [] }; }) as typeof readSubscription);
  for (const channel of ['trae-cn', 'trae-global']) {
    const result = await api.request(`http://127.0.0.1/${channel}?forceRefresh=1`);
    assert.equal(result.status, 200);
  }
  assert.deepEqual(calls, [['trae-cn', { forceRefresh: true }], ['trae-global', { forceRefresh: true }]]);
});

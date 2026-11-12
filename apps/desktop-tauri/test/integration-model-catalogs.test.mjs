import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegrationModelCatalogs } from '../dist/host/integration-model-catalogs.js';
const provider = { id: 'one', preset: 'qoder', baseUrl: 'https://example.invalid', protocol: 'chat', auth: { kind: 'subscription' } };
test('catalogs isolate accounts, deduplicate refreshes and retry failures without losing names', async () => {
  let now = 0; let calls = 0; let fail = false;
  const cache = new IntegrationModelCatalogs(async p => { calls++; if (fail) throw new Error('offline'); return { models: ['opaque'], names: { opaque: p.id } }; }, () => now);
  const accounts = [provider, { ...provider, id: 'two' }];
  await Promise.all([cache.refresh(accounts), cache.refresh(accounts)]);
  assert.equal(calls, 2); assert.equal(cache.get(provider).names.opaque, 'one'); assert.equal(cache.get(accounts[1]).names.opaque, 'two');
  await cache.refresh(accounts); assert.equal(calls, 2);
  now += 300001; fail = true; await cache.refresh(accounts); assert.equal(calls, 4); assert.equal(cache.get(provider).names.opaque, 'one');
  await cache.refresh(accounts); assert.equal(calls, 4);
  now += 60001; fail = false; await cache.refresh(accounts); assert.equal(calls, 6);
  const changed = { ...provider, baseUrl: 'https://other.invalid' };
  assert.equal(cache.get(changed), undefined); await cache.refresh([changed]); assert.equal(cache.get(provider), undefined);
  cache.clear(); assert.equal(cache.get(changed), undefined);
});
test('clearing while a request is pending cannot restore an old account catalog', async () => {
  let resolve; const cache = new IntegrationModelCatalogs(() => new Promise(r => { resolve = r; }));
  const pending = cache.refresh([provider]); cache.clear(); resolve({ models: ['old'] }); await pending;
  assert.equal(cache.get(provider), undefined);
});
test('an explicit catalog refresh supersedes an older background result', async () => {
  let resolve; const cache = new IntegrationModelCatalogs(() => new Promise(r => { resolve = r; }));
  const pending = cache.refresh([provider]); cache.remember(provider, { models: ['fresh'] });
  resolve({ models: ['stale'] }); await pending;
  assert.deepEqual(cache.get(provider).models, ['fresh']);
});

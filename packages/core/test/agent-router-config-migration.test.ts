import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRouterConfig, validateRouterConfig } from '../src/agent-router/config.js';
import { makeRouterPreset } from '../src/agent-router/presets.js';

function retired(id = 'old-account') {
  return { id, preset: 'qoder', name: 'Old account', enabled: true, protocol: 'chat',
    baseUrl: 'https://api3.qoder.sh', models: ['efficient'], auth: { kind: 'subscription', provider: 'qoder', method: 'browser' } };
}
async function fixture(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'jusage-config-migration-'));
  const path = join(dir, 'config.json'); const raw = JSON.stringify(value, null, 2) + '\n';
  await writeFile(path, raw); return { dir, path, raw };
}
test('restored subscriptions and their groups survive loading unchanged', async () => {
  const original = { version: 1, port: 19000, providers: [retired(), makeRouterPreset('codex', 'responses')], groups: [{ id: 'g', members: ['old-account/efficient'] }] };
  const f = await fixture(original);
  assert.deepEqual(await loadRouterConfig(f.path), validateRouterConfig(original));
  assert.equal(await readFile(f.path, 'utf8'), f.raw);
  assert.deepEqual(await readdir(f.dir), ['config.json']);
});
test('unknown channels and unrelated corruption remain errors and do not overwrite the original', async () => {
  const codex = makeRouterPreset('codex', 'responses');
  const base = { version: 1, port: 0, providers: [retired(), codex], groups: [] };
  for (const value of [
    { ...base, providers: [retired(), { ...codex, baseUrl: 'https://wrong.example' }] },
    { ...base, providers: [retired(), { ...codex, id: 'old-account' }] },
    { ...base, groups: [{ id: 'bad', members: ['missing/model'] }] },
    { ...base, groups: [{ id: 'bad', members: [] }] },
    { ...base, providers: [{ ...retired(), preset: 'unknown', auth: { kind: 'subscription', provider: 'unknown', method: 'browser' } }] },
    { ...base, version: 2 },
  ]) {
    const f = await fixture(value);
    await assert.rejects(loadRouterConfig(f.path), /ROUTER_CONFIG_UNREADABLE/);
    assert.equal(await readFile(f.path, 'utf8'), f.raw);
    assert.deepEqual(await readdir(f.dir), ['config.json']);
  }
});

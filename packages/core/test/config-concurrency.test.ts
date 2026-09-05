import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { loadConfig, saveConfig, setLastSyncAt, setLastUploadAt } from '../src/config.js';
import { configPath } from '../src/paths.js';
import { createLocalApiApp } from '../src/server/local-api.js';
import { BucketStore } from '../src/server/state.js';
import type { TudConfig } from '../src/types.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tud-config-concurrency-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { config } = await loadConfig(dir);
  const app = createLocalApiApp({
    dataDir: dir,
    getConfig: () => config,
    bucketStore: new BucketStore(),
  });
  return {
    dir, config,
    readSaved: async () => JSON.parse(await readFile(configPath(dir), 'utf8')) as TudConfig,
    disable: async () => {
      const response = await app.request('/functions/tud-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ juejin: {
          enabled: false,
          apiUrl: 'https://example.invalid/changed',
          userName: 'saved by user',
        } }),
      });
      assert.equal(response.status, 200);
    },
  };
}

async function writer(t: TestContext, dir: string, operation: string, rounds = 1) {
  const child = fork(new URL('./fixtures/config-writer.js', import.meta.url),
    [dir, operation, String(rounds)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let doneResolve!: () => void;
  let doneReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise<void>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  // Child startup can fail before the caller begins awaiting completion.
  void done.catch(() => {});
  child.on('error', (error) => { readyReject(error); doneReject(error); });
  child.on('message', (raw) => {
    const message = raw as { type: string; error?: string };
    if (message.type === 'ready') readyResolve();
    if (message.type === 'error') {
      const error = new Error(message.error);
      readyReject(error); doneReject(error);
    }
  });
  child.on('exit', (code) => {
    if (code === 0) doneResolve();
    else {
      const error = new Error(`writer exited ${code}: ${stderr}`);
      readyReject(error); doneReject(error);
    }
  });
  await ready;
  return { done, start: () => child.send('start') };
}

for (const operation of ['sync', 'upload']) {
  test(`${operation} completion in another process preserves settings saved through the API`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const child = await writer(t, f.dir, operation);
    await f.disable();
    const savedSettings = (await f.readSaved()).juejin;
    child.start();
    await child.done;
    const saved = await f.readSaved();
    assert.deepEqual(saved.juejin, savedSettings);
    assert.ok(saved[operation === 'sync' ? 'lastSyncAt' : 'lastUploadAt']);
  });
}

test('settings saved from an older snapshot preserve completed sync and upload times', async (t) => {
  const f = await fixture(t);
  const settingsSnapshot = structuredClone(f.config);
  await setLastSyncAt(f.dir, f.config);
  await setLastUploadAt(f.dir, f.config);
  const completed = await f.readSaved();
  settingsSnapshot.juejin.enabled = false;
  await saveConfig(f.dir, settingsSnapshot);
  const saved = await f.readSaved();
  assert.equal(saved.lastSyncAt, completed.lastSyncAt);
  assert.equal(saved.lastUploadAt, completed.lastUploadAt);
  assert.equal(saved.juejin.enabled, false);
});

test('concurrent settings, sync and upload writers retain settings and both timestamps', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const writers = await Promise.all(['settings', 'sync', 'upload'].map((operation) =>
    writer(t, f.dir, operation, 12)));
  for (const child of writers) child.start();
  let finished = false;
  const completed = Promise.all(writers.map((child) => child.done))
    .finally(() => { finished = true; });
  try {
    // These reads deliberately do not take the lock. Atomic replacement must
    // keep config.json parseable even for non-cooperating readers.
    while (!finished) await f.readSaved();
  } finally {
    await completed;
  }
  const saved = await f.readSaved();
  assert.equal(saved.juejin.enabled, false);
  assert.equal(saved.juejin.userName, 'saved-11');
  assert.ok(saved.lastSyncAt);
  assert.ok(saved.lastUploadAt);
  assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')));
});

test('timestamp setters still initialize an unsaved fixture and update the caller', async (t) => {
  const f = await fixture(t);
  await rm(configPath(f.dir));
  await setLastSyncAt(f.dir, f.config);
  await setLastUploadAt(f.dir, f.config);
  const saved = await f.readSaved();
  assert.equal(saved.deviceId, f.config.deviceId);
  assert.equal(saved.lastSyncAt, f.config.lastSyncAt);
  assert.equal(saved.lastUploadAt, f.config.lastUploadAt);
});

test('failed timestamp writes leave corrupt contents intact and release the lock', async (t) => {
  const f = await fixture(t);
  const previousTime = f.config.lastSyncAt;
  await writeFile(configPath(f.dir), '{broken', 'utf8');
  await assert.rejects(setLastSyncAt(f.dir, f.config), SyntaxError);
  assert.equal(f.config.lastSyncAt, previousTime);
  assert.equal(await readFile(configPath(f.dir), 'utf8'), '{broken');
  assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')));

  const recovered = await loadConfig(f.dir);
  assert.ok(recovered.recoveredFromCorrupt);
  await setLastSyncAt(f.dir, recovered.config);
});

test('configuration can be loaded after recovering a stale crash lock', async (t) => {
  const f = await fixture(t);
  const lockPath = `${configPath(f.dir)}.lock`;
  await mkdir(lockPath);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const loaded = await loadConfig(f.dir);
  assert.equal(loaded.config.deviceId, f.config.deviceId);
  assert.ok(!(await readdir(f.dir)).includes('config.json.lock'));
});

test('concurrent first loads agree on a single initialized identity', async (t) => {
  const f = await fixture(t);
  await rm(configPath(f.dir));
  const loaded = await Promise.all(Array.from({ length: 5 }, () => loadConfig(f.dir)));
  const saved = await f.readSaved();
  assert.ok(loaded.every(({ config }) => config.deviceId === saved.deviceId));
  assert.ok(!(await readdir(f.dir)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')));
});

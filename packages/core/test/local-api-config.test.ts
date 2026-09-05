import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { loadConfig } from '../src/config.js';
import { configPath } from '../src/paths.js';
import { createLocalApiApp } from '../src/server/local-api.js';
import { BucketStore } from '../src/server/state.js';
import type { TudConfig, TudConfigUpdate, TudConfigView } from '../src/types.js';

async function fixture(
  t: TestContext,
  onConfigChange?: (config: TudConfig) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), 'tud-config-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { config } = await loadConfig(dir);
  const app = createLocalApiApp({
    dataDir: dir,
    getConfig: () => config,
    bucketStore: new BucketStore(),
    onConfigChange,
  });
  // Keep the intentional filesystem failure below out of the test console.
  app.onError(() => new Response('Internal Server Error', { status: 500 }));
  return {
    dir,
    config,
    app,
    readSaved: async () =>
      JSON.parse(await readFile(configPath(dir), 'utf8')) as TudConfig,
    update: (body: TudConfigUpdate) =>
      app.request('/functions/tud-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

for (const apiUrl of ['invalid-url', 'file:///tmp/config', 'javascript:void(0)']) {
  test(`rejected API URL ${apiUrl} leaves the active and saved config unchanged`, async (t) => {
    let notifications = 0;
    const f = await fixture(t, () => { notifications += 1; });
    const before = structuredClone(f.config);

    const response = await f.update({ juejin: { enabled: false, apiUrl } });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { message: string }).message, 'INVALID_API_URL');
    assert.deepEqual(f.config, before);
    assert.deepEqual(await f.readSaved(), before);
    assert.equal(notifications, 0);

    const readback = await f.app.request('/functions/tud-config');
    const body = await readback.json() as { data: TudConfigView };
    assert.equal(body.data.juejin.enabled, before.juejin.enabled);
  });
}

test('a failed config save does not change active settings or notify listeners', async (t) => {
  let notifications = 0;
  const f = await fixture(t, () => { notifications += 1; });
  const before = structuredClone(f.config);
  // A directory at the destination deterministically rejects writeFile on all
  // platforms without depending on user privileges or filesystem permissions.
  await rm(configPath(f.dir));
  await mkdir(configPath(f.dir));

  const response = await f.update({
    juejin: { enabled: false, apiUrl: 'https://example.invalid/usage', userName: 'changed' },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(f.config, before);
  assert.equal(notifications, 0);
});

for (const withListener of [false, true]) {
  test(`valid config updates persist and remain readable ${withListener ? 'with' : 'without'} a listener`, async (t) => {
    const notifications: TudConfig[] = [];
    const f = await fixture(t, withListener ? (next) => { notifications.push(next); } : undefined);
    const before = structuredClone(f.config);

    const response = await f.update({
      juejin: {
        enabled: false,
        apiUrl: ' https://example.invalid/usage ',
        token: ' "12345678" ',
        userName: ' Fixture User ',
        avatarLarge: ' https://example.invalid/avatar.png ',
      },
    });
    assert.equal(response.status, 200);
    const expected: TudConfig = {
      ...before,
      juejin: {
        ...before.juejin,
        enabled: false,
        apiUrl: 'https://example.invalid/usage',
        token: '12345678',
        originUserId: '12345678',
        userName: 'Fixture User',
        avatarLarge: 'https://example.invalid/avatar.png',
      },
    };
    assert.deepEqual(await f.readSaved(), expected);
    assert.deepEqual(f.config, expected);
    assert.equal(notifications.length, withListener ? 1 : 0);
    if (withListener) assert.strictEqual(notifications[0], f.config);

    const readback = await f.app.request('/functions/tud-config');
    assert.deepEqual(await readback.json(), await response.json());

    const clear = await f.update({
      juejin: { token: null, originUserId: null, userName: null, avatarLarge: null },
    });
    assert.equal(clear.status, 200);
    assert.equal(f.config.juejin.token, null);
    assert.equal(f.config.juejin.originUserId, null);
    assert.equal(f.config.juejin.userName, null);
    assert.equal(f.config.juejin.avatarLarge, null);
    assert.deepEqual(await f.readSaved(), f.config);
  });
}

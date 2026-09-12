import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  readStableDeviceId,
  resolveOrCreateDeviceId,
  writeStableDeviceId,
} from '../src/config.js';
import { configPath, stableDeviceIdPath } from '../src/paths.js';

async function withIsolatedConfigHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'jusage-cfg-home-'));
  const prev = process.env.JUSAGE_CONFIG_HOME;
  process.env.JUSAGE_CONFIG_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.JUSAGE_CONFIG_HOME;
    else process.env.JUSAGE_CONFIG_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test('resolveOrCreateDeviceId reuses sidecar after wipe of data dir', async () => {
  await withIsolatedConfigHome(async () => {
    const first = await resolveOrCreateDeviceId();
    assert.match(first.deviceId, /^[0-9a-f-]{36}$/i);
    assert.equal(first.created, true);
    assert.equal(await readStableDeviceId(), first.deviceId);

    const again = await resolveOrCreateDeviceId();
    assert.equal(again.deviceId, first.deviceId);
    assert.equal(again.created, false);
  });
});

test('loadConfig migrates existing deviceId to sidecar and recovers after wipe', async () => {
  await withIsolatedConfigHome(async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-usage-data-'));
    try {
      const deviceId = '550e8400-e29b-41d4-a716-446655440000';
      await writeFile(
        configPath(dataDir),
        JSON.stringify({
          deviceId,
          statsSince: '2026-01-01T00:00:00.000Z',
          hostname: 'test',
          dataDir,
          juejin: {
            enabled: true,
            apiUrl: 'https://api.juejin.cn/aiusage_api',
            authMode: 'tbd',
            token: 'jau.opaque',
          },
          serverPort: 8452,
          lastSyncAt: null,
        }),
        'utf8',
      );

      const loaded = await loadConfig(dataDir);
      assert.equal(loaded.config.deviceId, deviceId);
      assert.equal(await readFile(stableDeviceIdPath(), 'utf8'), `${deviceId}\n`);

      await rm(dataDir, { recursive: true, force: true });
      const dataDir2 = await mkdtemp(join(tmpdir(), 'ai-usage-data-'));
      try {
        const reloaded = await loadConfig(dataDir2);
        assert.equal(reloaded.config.deviceId, deviceId);
        assert.equal(reloaded.config.juejin.token, deviceId);
      } finally {
        await rm(dataDir2, { recursive: true, force: true });
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

test('writeStableDeviceId rejects invalid ids', async () => {
  await withIsolatedConfigHome(async () => {
    await assert.rejects(() => writeStableDeviceId('not-a-uuid'), /Invalid deviceId/);
  });
});

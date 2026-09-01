import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetJuejinProfileSyncStateForTests } from '../src/juejin-profile.js';
import { createLocalApiApp } from '../src/server/local-api.js';
import { BucketStore, type LocalApiDeps } from '../src/server/state.js';
import type { TudConfig, TudConfigView } from '../src/types.js';

function config(dir: string): TudConfig {
  return {
    deviceId: 'device-test',
    statsSince: '2026-01-01T00:00:00.000Z',
    hostname: 'test',
    dataDir: dir,
    juejin: {
      enabled: true,
      apiUrl: 'https://usage.example.com',
      authMode: 'bearer',
      token: 'jau.opaque',
      originUserId: '200000000000001',
      userName: '压抑了',
      avatarLarge:
        'https://p3-passport.byteacctimg.com/img/user-avatar/oldhash~300x300.image',
    },
  };
}

test('tud-refresh-profile writes remote name and avatar into config', async () => {
  resetJuejinProfileSyncStateForTests();
  const dir = await mkdtemp(join(tmpdir(), 'tud-api-profile-'));
  const value = config(dir);
  const deps: LocalApiDeps = {
    dataDir: dir,
    getConfig: () => value,
    bucketStore: new BucketStore(),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        err_no: 0,
        data: {
          user_id: '200000000000001',
          user_name: '未知用户undefined',
          avatar_large:
            'https://p3-passport.byteacctimg.com/img/user-avatar/newhash~300x300.image',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  try {
    const response = await createLocalApiApp(deps).request(
      '/functions/tud-refresh-profile',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
    );
    const body = (await response.json()) as {
      success: boolean;
      data: {
        changed: boolean;
        config: TudConfigView;
      };
    };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.changed, true);
    assert.equal(body.data.config.juejin.userName, '未知用户undefined');
    assert.match(body.data.config.juejin.avatarLarge ?? '', /newhash/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

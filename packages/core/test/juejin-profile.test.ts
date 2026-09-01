import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bakedPricingConfig } from '../src/config.js';
import { configPath } from '../src/paths.js';
import {
  JUEJIN_PROFILE_AUTO_MIN_INTERVAL_MS,
  isUsableAvatarUrl,
  isUsableDisplayName,
  parseTudSessionPayload,
  resetJuejinProfileSyncStateForTests,
  syncJuejinProfile,
} from '../src/juejin-profile.js';
import type { TudConfig } from '../src/types.js';

function config(partial?: Partial<TudConfig['juejin']>): TudConfig {
  return {
    deviceId: '550e8400-e29b-41d4-a716-446655440000',
    statsSince: '2026-01-01T00:00:00.000Z',
    hostname: 'test',
    dataDir: '/tmp',
    juejin: {
      enabled: true,
      apiUrl: 'https://api.juejin.cn/aiusage_api',
      authMode: 'tbd',
      token: 'jau.opaque',
      originUserId: '916310739397084',
      userName: '压抑了',
      avatarLarge:
        'https://p3-passport.byteacctimg.com/img/user-avatar/oldhash~300x300.image',
      ...partial,
    },
    pricing: bakedPricingConfig(),
  };
}

function payload(overrides?: Record<string, unknown>) {
  return {
    success: true,
    message: 'ok',
    data: {
      encryptedUserId: 'jau.opaque',
      originUserId: '916310739397084',
      userName: '新昵称',
      avatarLarge:
        'https://p3-passport.byteacctimg.com/img/user-avatar/newhash~300x300.image',
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('isUsableDisplayName accepts unusual but real nicknames', () => {
  assert.equal(isUsableDisplayName('压抑了'), true);
  assert.equal(isUsableDisplayName('未知用户undefined'), true);
  assert.equal(isUsableDisplayName(''), false);
});

test('isUsableAvatarUrl accepts https CDN urls', () => {
  assert.equal(
    isUsableAvatarUrl(
      'https://p3-passport.byteacctimg.com/img/user-avatar/abc~300x300.image',
    ),
    true,
  );
  assert.equal(isUsableAvatarUrl('http://insecure.example/a.png'), false);
  assert.equal(isUsableAvatarUrl('not a url'), false);
});

test('parseTudSessionPayload keeps unusual nicknames', () => {
  const parsed = parseTudSessionPayload(
    payload({ userName: '未知用户undefined' }),
  );
  assert.ok(parsed);
  assert.equal(parsed?.userName, '未知用户undefined');
  assert.match(parsed?.avatarLarge ?? '', /newhash/);
});

test('parseTudSessionPayload rejects failed envelopes', () => {
  assert.equal(
    parseTudSessionPayload({ success: false, message: 'UNAUTHENTICATED', data: null }),
    null,
  );
});

test('syncJuejinProfile writes tud-session name and avatar', async () => {
  resetJuejinProfileSyncStateForTests();
  const dir = await mkdtemp(join(tmpdir(), 'tud-profile-'));
  const value = config();
  value.dataDir = dir;
  try {
    const result = await syncJuejinProfile(dir, value, {
      force: true,
      nowMs: 1,
      fetchImpl: async (input, init) => {
        assert.equal(String(input), 'https://api.juejin.cn/aiusage_api/functions/tud-session');
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          'Bearer jau.opaque',
        );
        return jsonResponse(payload({ userName: '未知用户undefined' }));
      },
    });
    assert.equal(result.reason, 'updated');
    assert.equal(value.juejin.userName, '未知用户undefined');
    const saved = JSON.parse(await readFile(configPath(dir), 'utf8')) as TudConfig;
    assert.equal(saved.juejin.userName, '未知用户undefined');
    assert.match(saved.juejin.avatarLarge ?? '', /newhash/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncJuejinProfile keeps the login snapshot when session name is empty', async () => {
  resetJuejinProfileSyncStateForTests();
  const dir = await mkdtemp(join(tmpdir(), 'tud-profile-'));
  const value = config();
  try {
    const result = await syncJuejinProfile(dir, value, {
      force: true,
      nowMs: 1,
      fetchImpl: async () => jsonResponse(payload({ userName: '' })),
    });
    assert.equal(result.changed, true);
    assert.equal(value.juejin.userName, '压抑了');
    assert.match(value.juejin.avatarLarge ?? '', /newhash/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncJuejinProfile auto path is throttled until the interval elapses', async () => {
  resetJuejinProfileSyncStateForTests();
  const dir = await mkdtemp(join(tmpdir(), 'tud-profile-'));
  const value = config();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(payload());
  };
  try {
    const first = await syncJuejinProfile(dir, value, {
      nowMs: 10,
      fetchImpl,
    });
    assert.equal(first.reason, 'updated');
    const second = await syncJuejinProfile(dir, value, {
      nowMs: 11,
      fetchImpl,
    });
    assert.equal(second.reason, 'throttled');
    assert.equal(calls, 1);
    const forced = await syncJuejinProfile(dir, value, {
      force: true,
      nowMs: 11,
      fetchImpl,
    });
    assert.equal(forced.reason, 'unchanged');
    assert.equal(calls, 2);
    const later = await syncJuejinProfile(dir, value, {
      nowMs: 11 + JUEJIN_PROFILE_AUTO_MIN_INTERVAL_MS,
      fetchImpl,
    });
    assert.equal(later.reason, 'unchanged');
    assert.equal(calls, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncJuejinProfile is a no-op when the upload token is still the deviceId', async () => {
  resetJuejinProfileSyncStateForTests();
  const value = config({ token: '550e8400-e29b-41d4-a716-446655440000' });
  const result = await syncJuejinProfile('/tmp', value, {
    force: true,
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });
  assert.equal(result.reason, 'not_linked');
  assert.equal(result.changed, false);
});

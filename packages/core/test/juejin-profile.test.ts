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
  parseJuejinUserGetPayload,
  resetJuejinProfileSyncStateForTests,
  resolveProfileOriginUserId,
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
    err_no: 0,
    err_msg: 'success',
    data: {
      user_id: '916310739397084',
      user_name: '新昵称',
      avatar_large:
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
  assert.equal(isUsableDisplayName('松尾'), true);
  assert.equal(isUsableDisplayName('未知用户undefined'), true);
  assert.equal(isUsableDisplayName(''), false);
  assert.equal(isUsableDisplayName('   '), false);
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
  assert.equal(isUsableAvatarUrl('https://evil.example/a.png with space'), false);
});

test('parseJuejinUserGetPayload keeps unusual nicknames', () => {
  const parsed = parseJuejinUserGetPayload(
    payload({ user_name: '未知用户undefined' }),
    '916310739397084',
  );
  assert.ok(parsed);
  assert.equal(parsed?.userName, '未知用户undefined');
  assert.match(parsed?.avatarLarge ?? '', /newhash/);
});

test('parseJuejinUserGetPayload rejects a different user id', () => {
  const parsed = parseJuejinUserGetPayload(
    payload({ user_id: '1234567890' }),
    '916310739397084',
  );
  assert.equal(parsed, null);
});

test('resolveProfileOriginUserId strips quoted ids', () => {
  const value = config({ originUserId: '"916310739397084"' });
  assert.equal(resolveProfileOriginUserId(value), '916310739397084');
  assert.equal(
    resolveProfileOriginUserId(config({ originUserId: null, token: 'jau.x' })),
    null,
  );
});

test('syncJuejinProfile writes the remote name even when it looks unusual', async () => {
  resetJuejinProfileSyncStateForTests();
  const dir = await mkdtemp(join(tmpdir(), 'tud-profile-'));
  const value = config();
  value.dataDir = dir;
  try {
    const result = await syncJuejinProfile(dir, value, {
      force: true,
      nowMs: 1,
      fetchImpl: async () =>
        jsonResponse(payload({ user_name: '未知用户undefined' })),
    });
    assert.equal(result.reason, 'updated');
    assert.equal(result.changed, true);
    assert.equal(result.userName, '未知用户undefined');
    assert.match(result.avatarLarge ?? '', /newhash/);
    const saved = JSON.parse(await readFile(configPath(dir), 'utf8')) as TudConfig;
    assert.equal(saved.juejin.userName, '未知用户undefined');
    assert.match(saved.juejin.avatarLarge ?? '', /newhash/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncJuejinProfile keeps the login snapshot when remote name is empty', async () => {
  resetJuejinProfileSyncStateForTests();
  const dir = await mkdtemp(join(tmpdir(), 'tud-profile-'));
  const value = config();
  try {
    const result = await syncJuejinProfile(dir, value, {
      force: true,
      nowMs: 1,
      fetchImpl: async () => jsonResponse(payload({ user_name: '' })),
    });
    assert.equal(result.changed, true);
    assert.equal(result.userName, '压抑了');
    assert.match(result.avatarLarge ?? '', /newhash/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncJuejinProfile writes a usable remote name', async () => {
  resetJuejinProfileSyncStateForTests();
  const dir = await mkdtemp(join(tmpdir(), 'tud-profile-'));
  const value = config();
  try {
    const result = await syncJuejinProfile(dir, value, {
      force: true,
      nowMs: 1,
      fetchImpl: async () => jsonResponse(payload()),
    });
    assert.equal(result.reason, 'updated');
    assert.equal(result.userName, '新昵称');
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

test('syncJuejinProfile is a no-op without a linked origin user id', async () => {
  resetJuejinProfileSyncStateForTests();
  const value = config({ originUserId: null, token: 'jau.opaque' });
  const result = await syncJuejinProfile('/tmp', value, {
    force: true,
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });
  assert.equal(result.reason, 'not_linked');
  assert.equal(result.fetched, false);
});

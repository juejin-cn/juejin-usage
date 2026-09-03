import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  createSyncRunner,
  readNotifySignalSource,
  watchRuntimeSignals,
} from '../src/server/sync-on-signal.js';
import { syncAll } from '../src/sync/index.js';
import type { TudConfig } from '../src/types.js';

function baseConfig(dataDir: string): TudConfig {
  return {
    deviceId: '550e8400-e29b-41d4-a716-446655440000',
    statsSince: '2026-01-01T00:00:00.000Z',
    hostname: 'test',
    dataDir,
    juejin: {
      enabled: false,
      apiUrl: 'http://127.0.0.1:8787',
      authMode: 'tbd',
      token: null,
    },
    serverPort: 8452,
    lastSyncAt: null,
  };
}

test('readNotifySignalSource returns source from JSON payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-signal-'));
  await writeFile(
    join(dir, 'notify.signal'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', source: 'codex' }),
    'utf8',
  );
  assert.equal(await readNotifySignalSource(dir), 'codex');
});

test('readNotifySignalSource returns undefined when missing or invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-signal-'));
  assert.equal(await readNotifySignalSource(dir), undefined);

  await writeFile(join(dir, 'notify.signal'), 'not-json', 'utf8');
  assert.equal(await readNotifySignalSource(dir), undefined);

  await writeFile(
    join(dir, 'notify.signal'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z' }),
    'utf8',
  );
  assert.equal(await readNotifySignalSource(dir), undefined);
});

test('createSyncRunner poll/manual sync all sources without checking hooks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-sync-runner-'));
  const config = baseConfig(dir);
  const calls: Array<{ source: string | undefined; reason: string }> = [];

  const { runSync } = createSyncRunner({
    dataDir: dir,
    getConfig: () => config,
    loadConfig: async () => ({ dir, config }),
    syncAllFn: async (_dataDir, _cfg, source) => {
      calls.push({ source, reason: 'captured' });
      return [];
    },
  });

  // Poll path — used by CLI/Desktop setInterval; must not require hooks.
  await runSync('poll');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.source, undefined);

  // Manual path with explicit channel (jusage sync --source / trigger-sync).
  await runSync('manual', 'claude');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.source, 'claude');

  await runSync('manual', 'codex');
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.source, 'codex');
});

test('createSyncRunner notify.signal respects source from payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-sync-source-'));
  const config = baseConfig(dir);
  const sources: Array<string | undefined> = [];

  const { runSync } = createSyncRunner({
    dataDir: dir,
    getConfig: () => config,
    loadConfig: async () => ({ dir, config }),
    syncAllFn: async (_dataDir, _cfg, source) => {
      sources.push(source);
      return [];
    },
  });

  await writeFile(
    join(dir, 'notify.signal'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', source: 'claude' }),
    'utf8',
  );
  const signalSource = await readNotifySignalSource(dir);
  await runSync('notify.signal', signalSource);
  assert.deepEqual(sources, ['claude']);

  await writeFile(
    join(dir, 'notify.signal'),
    JSON.stringify({ ts: '2026-01-01T00:00:01Z', source: 'codex' }),
    'utf8',
  );
  await runSync('notify.signal', await readNotifySignalSource(dir));
  assert.deepEqual(sources, ['claude', 'codex']);
});

test('syncAll with source=claude|codex only runs that channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-sync-all-'));
  const config = baseConfig(dir);

  const claudeOnly = await syncAll(dir, config, 'claude');
  assert.deepEqual(
    claudeOnly.map((r) => r.source),
    ['claude'],
  );

  const codexOnly = await syncAll(dir, config, 'codex');
  assert.deepEqual(
    codexOnly.map((r) => r.source),
    ['codex'],
  );
});

test('createSyncRunner coalesces overlapping poll and notify', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-sync-busy-'));
  const config = baseConfig(dir);
  let active = 0;
  let maxActive = 0;
  let calls = 0;

  const { runSync, isBusy } = createSyncRunner({
    dataDir: dir,
    getConfig: () => config,
    loadConfig: async () => ({ dir, config }),
    syncAllFn: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return [];
    },
  });

  const a = runSync('poll');
  assert.equal(isBusy(), true);
  const b = runSync('notify.signal', 'claude');
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(maxActive, 1);
  assert.equal(isBusy(), false);
});

test('watchRuntimeSignals runSyncOverride bypasses in-process createSyncRunner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-sync-override-'));
  const config = baseConfig(dir);
  const reasons: string[] = [];
  const { stop, runSync } = watchRuntimeSignals({
    dataDir: dir,
    getConfig: () => config,
    loadConfig: async () => ({ dir, config }),
    refreshFromDisk: async () => {},
    isOwner: () => true,
    runSyncOverride: async (reason) => {
      reasons.push(reason);
      return [];
    },
  });
  try {
    await runSync('poll');
    assert.deepEqual(reasons, ['poll']);
  } finally {
    stop();
  }
});

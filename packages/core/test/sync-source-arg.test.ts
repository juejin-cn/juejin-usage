import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalApiApp } from '../src/server/local-api.js';
import { BucketStore, type LocalApiDeps } from '../src/server/state.js';
import {
  SYNC_SOURCE_IDS,
  normalizeSyncSource,
  type SyncResult,
} from '../src/sync/index.js';
import type { TudConfig } from '../src/types.js';

test('normalizeSyncSource maps missing/empty/all to full sweep', () => {
  assert.equal(normalizeSyncSource(undefined), undefined);
  assert.equal(normalizeSyncSource(null), undefined);
  assert.equal(normalizeSyncSource(''), undefined);
  assert.equal(normalizeSyncSource('  '), undefined);
  assert.equal(normalizeSyncSource('all'), undefined);
  assert.equal(normalizeSyncSource('ALL'), undefined);
});

test('normalizeSyncSource keeps every registered id', () => {
  for (const id of SYNC_SOURCE_IDS) {
    assert.equal(normalizeSyncSource(id), id);
  }
});

test('normalizeSyncSource trims, lowercases and resolves aliases', () => {
  assert.equal(normalizeSyncSource(' Claude '), 'claude');
  assert.equal(normalizeSyncSource('DSH'), 'dsh');
  assert.equal(normalizeSyncSource('roo-code'), 'roocode');
  assert.equal(normalizeSyncSource('qwen-code'), 'qwen');
  assert.equal(normalizeSyncSource('grok-build'), 'grok');
  assert.equal(normalizeSyncSource('mimocode'), 'mimo');
  assert.equal(normalizeSyncSource('everycode'), 'every-code');
  assert.equal(normalizeSyncSource('kilo'), 'kilo-cli');
  assert.equal(normalizeSyncSource('kilo-code'), 'kilocode');
});

test('normalizeSyncSource rejects unknown values with null', () => {
  assert.equal(normalizeSyncSource('cluade'), null);
  assert.equal(normalizeSyncSource('does-not-exist'), null);
});

function config(): TudConfig {
  return {
    deviceId: 'device-test',
    statsSince: '2026-01-01T00:00:00.000Z',
    hostname: 'test',
    dataDir: '/tmp/tud-test',
    juejin: {
      enabled: false,
      apiUrl: 'https://usage.example.com',
      authMode: 'bearer',
      token: null,
    },
  };
}

function appWithRunnerSpy() {
  const calls: Array<string | undefined> = [];
  const runnerResults: SyncResult[] = [
    {
      source: 'claude',
      eventsParsed: 3,
      filesProcessed: 1,
      bucketsWritten: 2,
      writtenBuckets: [],
    },
    {
      source: 'workbuddy',
      eventsParsed: 0,
      filesProcessed: 0,
      bucketsWritten: 0,
      writtenBuckets: [],
      skipped: true,
      error: 'not installed / no local data',
    },
  ];
  const value = config();
  const deps: LocalApiDeps = {
    dataDir: value.dataDir,
    getConfig: () => value,
    bucketStore: new BucketStore(),
    runSyncViaRunner: async (_reason, source) => {
      calls.push(source);
      return runnerResults;
    },
  };
  return { app: createLocalApiApp(deps), calls, runnerResults };
}

function postTriggerSync(app: ReturnType<typeof createLocalApiApp>, body?: unknown) {
  return app.request('/functions/tud-trigger-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

test('tud-trigger-sync rejects unknown source with 400 and runs nothing', async () => {
  const { app, calls } = appWithRunnerSpy();
  const response = await postTriggerSync(app, { source: 'cluade' });
  assert.equal(response.status, 400);
  const envelope = (await response.json()) as {
    success: boolean;
    message: string;
    data: unknown;
  };
  assert.equal(envelope.success, false);
  assert.equal(envelope.message, 'UNKNOWN_SYNC_SOURCE');
  assert.equal(envelope.data, null);
  assert.equal(calls.length, 0);
});

test('tud-trigger-sync treats all/empty body as a full sweep', async () => {
  const { app, calls } = appWithRunnerSpy();

  const allResponse = await postTriggerSync(app, { source: 'all' });
  assert.equal(allResponse.status, 200);

  const emptyResponse = await postTriggerSync(app);
  assert.equal(emptyResponse.status, 200);

  assert.deepEqual(calls, [undefined, undefined]);
});

test('tud-trigger-sync normalizes single-source aliases and keeps result fields', async () => {
  const { app, calls, runnerResults } = appWithRunnerSpy();
  const response = await postTriggerSync(app, { source: ' Claude ' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['claude']);

  const envelope = (await response.json()) as {
    success: boolean;
    data: { ok: boolean; results: SyncResult[] } | null;
  };
  assert.equal(envelope.success, true);
  // skipped/error must survive the API envelope so callers can tell a
  // no-op apart from a healthy sync.
  assert.deepEqual(envelope.data?.results, runnerResults);
});

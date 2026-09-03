import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { uploadToServer } from '../src/upload/client.js';
import { saveUploadStateFile, setUploadSlot } from '../src/upload/state.js';
import { uploadLogPath } from '../src/paths.js';
import type { TudConfig } from '../src/types.js';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const API_URL = 'https://example.invalid';

function configFor(dir: string): TudConfig {
  return {
    deviceId: DEVICE_ID,
    statsSince: '2026-01-01T00:00:00.000Z',
    hostname: 'test',
    dataDir: dir,
    juejin: {
      enabled: true,
      apiUrl: API_URL,
      authMode: 'tbd',
      token: 'user-token-not-device',
    },
  };
}

test('uploadToServer skips ingest when recentBuckets is an empty array', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-upload-empty-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        data: { lastUploadAt: '2026-08-01T00:00:00.000Z' },
      }),
    )) as typeof fetch;
  try {
    await saveUploadStateFile(
      dir,
      setUploadSlot(
        { version: 2, remotes: {} },
        API_URL,
        DEVICE_ID,
        {
          buckets: { 'claude||opus|2026-08-01T00:00:00.000Z': 'deadbeefdeadbeef' },
          backfill: { items: [], enqueuedSince: '2026-01-01T00:00:00.000Z' },
        },
      ),
    );

    const result = await uploadToServer(dir, configFor(dir), {
      recentBuckets: [],
      skipDrain: true,
    });
    assert.equal(result?.uploaded, 0);
    assert.equal(result?.requestCount, 0);

    const log = await readFile(uploadLogPath(dir), 'utf8');
    assert.match(log, /no_recent_buckets/);
    assert.doesNotMatch(log, /incremental_to_full_scan/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendBuckets } from '../src/queue/index.js';
import { uploadToServer } from '../src/upload/client.js';
import {
  getUploadSlot,
  loadUploadStateFile,
  saveUploadStateFile,
  setUploadSlot,
} from '../src/upload/state.js';
import { uploadLogPath } from '../src/paths.js';
import type { QueueBucket, TudConfig } from '../src/types.js';

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

function recentHourIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function liveBucket(hourStart: string): QueueBucket {
  return {
    hour_start: hourStart,
    source: 'claude',
    model: 'claude-opus-4-6',
    project: '',
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 120,
    conversation_count: 1,
  };
}

test('live post failure enqueues backfill and sets needsFullScan', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-upload-live-fail-'));
  const hour = recentHourIso();
  const bucket = liveBucket(hour);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('tud-sync-status')) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            lastUploadAt: '2026-08-01T00:00:00.000Z',
            ingestMinOccurredAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      );
    }
    if (url.includes('/v1/model-usage/reports')) {
      return new Response('gateway timeout', { status: 504 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    await appendBuckets(dir, [bucket]);
    await saveUploadStateFile(
      dir,
      setUploadSlot(
        { version: 2, remotes: {} },
        API_URL,
        DEVICE_ID,
        {
          buckets: {
            'claude||other|2026-08-01T00:00:00.000Z': 'deadbeefdeadbeef',
          },
          backfill: { items: [], enqueuedSince: '2026-01-01T00:00:00.000Z' },
        },
      ),
    );

    await assert.rejects(
      () =>
        uploadToServer(dir, configFor(dir), {
          recentBuckets: [bucket],
          skipDrain: true,
        }),
      /504|gateway|上报|HTTP/i,
    );

    const slot = getUploadSlot(await loadUploadStateFile(dir), API_URL, DEVICE_ID);
    assert.equal(slot.needsFullScan, true);
    assert.ok((slot.backfill?.items.length ?? 0) >= 1);
    assert.ok(
      slot.backfill?.items.some((item) => item.key.includes(hour.slice(0, 13))),
    );

    const log = await readFile(uploadLogPath(dir), 'utf8');
    assert.match(log, /live_failed_enqueued_backfill/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('needsFullScan forces full scan even when recentBuckets is empty', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-upload-needs-full-'));
  const hour = recentHourIso();
  const bucket = liveBucket(hour);
  const originalFetch = globalThis.fetch;
  let reportPosts = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('tud-sync-status')) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            lastUploadAt: '2026-08-01T00:00:00.000Z',
            ingestMinOccurredAt: '2026-01-01T00:00:00.000Z',
          },
        }),
      );
    }
    if (url.includes('/v1/model-usage/reports')) {
      reportPosts += 1;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            accepted_count: 1,
            duplicate_count: 0,
            report_id: 'r1',
          },
        }),
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    await appendBuckets(dir, [bucket]);
    await saveUploadStateFile(
      dir,
      setUploadSlot(
        { version: 2, remotes: {} },
        API_URL,
        DEVICE_ID,
        {
          buckets: {
            'claude||other|2026-08-01T00:00:00.000Z': 'deadbeefdeadbeef',
          },
          backfill: { items: [], enqueuedSince: '2026-01-01T00:00:00.000Z' },
          needsFullScan: true,
        },
      ),
    );

    const result = await uploadToServer(dir, configFor(dir), {
      recentBuckets: [],
      skipDrain: true,
    });
    assert.ok(result);
    assert.ok(reportPosts >= 1);
    assert.ok((result?.uploaded ?? 0) + (result?.accepted ?? 0) >= 0);

    const slot = getUploadSlot(await loadUploadStateFile(dir), API_URL, DEVICE_ID);
    assert.ok(!slot.needsFullScan);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

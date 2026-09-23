import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aggregateForIngest } from '../src/aggregate.js';
import { appendBuckets } from '../src/queue/index.js';
import {
  maybeUploadAfterSync,
  stopBackfillDrain,
  uploadToServer,
} from '../src/upload/client.js';
import type { IngestEventPayload } from '../src/upload/events.js';
import {
  commitBucketHashes,
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

function projectRow(hourStart: string, project: string, tokens: number): QueueBucket {
  return {
    hour_start: hourStart,
    source: 'claude',
    model: 'claude-opus-4-6',
    project,
    collector: 'claude-code-cli',
    input_tokens: tokens,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: tokens,
    conversation_count: 1,
  };
}

/** Mock the ingest server and collect every event it receives. */
function mockIngest(): { posted: IngestEventPayload[][]; restore: () => void } {
  const posted: IngestEventPayload[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
      const body = JSON.parse(String(init?.body)) as { events: IngestEventPayload[] };
      posted.push(body.events);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            accepted_count: body.events.length,
            duplicate_count: 0,
            report_id: `r${posted.length}`,
          },
        }),
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { posted, restore: () => (globalThis.fetch = originalFetch) };
}

test('incremental upload sends the whole bucket, not only the projects this sync rewrote', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-upload-whole-bucket-'));
  const hour = recentHourIso();
  const alpha = projectRow(hour, 'alpha', 100);
  const beta = projectRow(hour, 'beta', 50);
  const ingest = mockIngest();
  try {
    await appendBuckets(dir, [alpha, beta]);
    await saveUploadStateFile(
      dir,
      setUploadSlot(
        { version: 2, remotes: {} },
        API_URL,
        DEVICE_ID,
        {
          ...commitBucketHashes({ buckets: {} }, aggregateForIngest([alpha, beta])),
          backfill: { items: [], enqueuedSince: '2026-01-01T00:00:00.000Z' },
        },
      ),
    );

    // Only project beta grows in this sync round.
    const betaGrown = projectRow(hour, 'beta', 80);
    await appendBuckets(dir, [betaGrown]);
    await uploadToServer(dir, configFor(dir), {
      recentBuckets: [betaGrown],
      skipDrain: true,
    });

    const log = await readFile(uploadLogPath(dir), 'utf8');
    assert.match(log, /"mode":"incremental"/);
    assert.equal(ingest.posted.length, 1);
    assert.equal(ingest.posted[0]!.length, 1);
    assert.equal(ingest.posted[0]![0]!.usage.input_tokens, 180);
    assert.equal(ingest.posted[0]![0]!.conversations_count, 2);
  } finally {
    ingest.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('first upload after start re-sends buckets an older client uploaded partially', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tud-upload-whole-bucket-heal-'));
  const hour = recentHourIso();
  const alpha = projectRow(hour, 'alpha', 100);
  const beta = projectRow(hour, 'beta', 50);
  const ingest = mockIngest();
  try {
    await appendBuckets(dir, [alpha, beta]);
    // What the old incremental path committed: the bucket hash of beta alone.
    await saveUploadStateFile(
      dir,
      setUploadSlot(
        { version: 2, remotes: {} },
        API_URL,
        DEVICE_ID,
        {
          ...commitBucketHashes({ buckets: {} }, aggregateForIngest([beta])),
          backfill: { items: [], enqueuedSince: '2026-01-01T00:00:00.000Z' },
        },
      ),
    );

    await maybeUploadAfterSync(dir, configFor(dir), []);
    assert.equal(ingest.posted.length, 1);
    assert.equal(ingest.posted[0]![0]!.usage.input_tokens, 150);

    // Later rounds in the same process go back to incremental.
    await maybeUploadAfterSync(dir, configFor(dir), []);
    assert.equal(ingest.posted.length, 1);
    const log = await readFile(uploadLogPath(dir), 'utf8');
    assert.match(log, /no_recent_buckets/);
  } finally {
    stopBackfillDrain();
    ingest.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

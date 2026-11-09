import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { maybeUploadAfterSync, stopBackfillDrain } from '../src/upload/client.js';
import { appendBuckets } from '../src/queue/index.js';
import { runSync, BucketStore } from '../src/server/state.js';
import { createSyncRunner } from '../src/server/sync-on-signal.js';
import type { TudConfig } from '../src/types.js';

function configFor(dir: string): TudConfig {
  return { dataDir: dir, deviceId: '550e8400-e29b-41d4-a716-446655440000', hostname: 'test',
    statsSince: '2026-01-01T00:00:00.000Z',
    juejin: { enabled: true, apiUrl: 'https://example.invalid', authMode: 'tbd', token: 'linked-user-token' } };
}

test('manual sync preserves local success and exposes skipped/failed/uploaded outcomes from shared runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-feedback-'));
  const originalFetch = globalThis.fetch;
  const config = configFor(dir);
  const runner = createSyncRunner({ dataDir: dir, getConfig: () => config,
    loadConfig: async () => ({ dir, config }), syncAllFn: async () => [] });
  const deps = { dataDir: dir, getConfig: () => config, bucketStore: new BucketStore(), runSyncViaRunner: runner.runSync };
  try {
    config.juejin.enabled = false;
    assert.equal((await runSync(deps)).cloudUpload.status, 'skipped');
    config.juejin.enabled = true;
    config.juejin.token = config.deviceId;
    assert.deepEqual(await maybeUploadAfterSync(dir, config), { status: 'skipped' });
    config.juejin.token = 'linked-user-token';
    await appendBuckets(dir, [{ hour_start: new Date().toISOString(), source: 'codex', model: 'gpt-5', project: '',
      input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0, total_tokens: 120, conversation_count: 1 }]);
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    const failed = await runSync(deps);
    assert.equal(failed.ok, true);
    assert.equal(failed.cloudUpload.status, 'failed');
    stopBackfillDrain();
    globalThis.fetch = async (input) => String(input).includes('tud-sync-status')
      ? Response.json({ success: true, data: { lastUploadAt: null, ingestMinOccurredAt: null } })
      : Response.json({ success: true, data: { accepted_count: 1, duplicate_count: 0, report_id: 'test' } });
    const uploaded = await runSync(deps);
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.cloudUpload.status, 'uploaded');
    stopBackfillDrain();
    // A fresh device queue has no older backfill left after its live upload.
    const cleanDir = await mkdtemp(join(tmpdir(), 'cloud-feedback-clean-'));
    try {
      const clean = configFor(cleanDir);
      assert.equal((await maybeUploadAfterSync(cleanDir, clean)).status, 'uploaded');
    } finally { stopBackfillDrain(); await rm(cleanDir, { recursive: true, force: true }); }
    const legacy = await runSync({ ...deps, runSyncViaRunner: async () => [] });
    assert.equal(legacy.cloudUpload.status, 'unknown');
  } finally {
    stopBackfillDrain(); globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

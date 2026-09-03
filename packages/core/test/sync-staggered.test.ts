import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SYNC_SOURCE_IDS, syncAllStaggered } from '../src/sync/index.js';
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

test('syncAllStaggered visits sources with gaps and skips missing installs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-stagger-'));
  try {
    const seen: string[] = [];
    const ticks: Array<{ skipped: boolean; t: number }> = [];

    const results = await syncAllStaggered(dir, baseConfig(dir), {
      gapMs: 40,
      onSourceDone: async (result) => {
        ticks.push({ skipped: Boolean(result.skipped), t: Date.now() });
        seen.push(result.source);
      },
    });

    assert.equal(results.length, SYNC_SOURCE_IDS.length);
    assert.equal(seen.length, SYNC_SOURCE_IDS.length);
    assert.deepEqual(
      seen,
      SYNC_SOURCE_IDS.map((id) => id),
    );
    // At least claude always runs (not skipped via presence); skipped count is environment-dependent.
    assert.ok(results.some((r) => r.source === 'claude'));

    // Skipped channels must not insert the stagger gap.
    const skippedGaps: number[] = [];
    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i]!.skipped && ticks[i - 1]!.skipped) {
        skippedGaps.push(ticks[i]!.t - ticks[i - 1]!.t);
      }
    }
    if (skippedGaps.length > 0) {
      assert.ok(
        skippedGaps.every((g) => g < 25),
        `skipped source gaps should be << 40ms, got ${skippedGaps.join(',')}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SYNC_SOURCE_IDS, syncAllStaggered } from '../src/sync/index.js';
import type { TudConfig } from '../src/types.js';
import {
  isolateAgentHome,
  SEEDED_CLAUDE,
  SEEDED_CODEX,
  seedClaudeSession,
  seedCodexSession,
} from './platform-fixtures.js';

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
  // Sandboxed home: only the two sources seeded below exist. Without this the
  // round walks the developer's real ~/.claude, ~/.codex, … — which made this
  // one case ~58s on a 500MB transcript tree, and left "how many sources were
  // skipped" a property of that machine rather than of the code under test.
  const home = await mkdtemp(join(tmpdir(), 'tud-stagger-home-'));
  const restoreEnv = isolateAgentHome(home);
  try {
    await seedClaudeSession(home);
    await seedCodexSession(home);

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

    const bySource = new Map(results.map((r) => [r.source, r]));
    assert.equal(bySource.get('claude')?.eventsParsed, SEEDED_CLAUDE.events);
    assert.equal(bySource.get('codex')?.eventsParsed, SEEDED_CODEX.events);

    // Everything else has nothing to read under the sandboxed home, so no
    // channel may invent events. This is what actually guards the round.
    const unexpected = results.filter(
      (r) => r.source !== 'claude' && r.source !== 'codex' && r.eventsParsed > 0,
    );
    assert.deepEqual(
      unexpected.map((r) => `${r.source}:${r.eventsParsed}`),
      [],
      'only the seeded sources may report events',
    );

    // Skipped channels must not insert the stagger gap.
    const skippedGaps: number[] = [];
    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i]!.skipped && ticks[i - 1]!.skipped) {
        skippedGaps.push(ticks[i]!.t - ticks[i - 1]!.t);
      }
    }
    assert.ok(skippedGaps.length > 0, 'sandboxed home must leave some source skipped');
    assert.ok(
      skippedGaps.every((g) => g < 25),
      `skipped source gaps should be << 40ms, got ${skippedGaps.join(',')}`,
    );
  } finally {
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

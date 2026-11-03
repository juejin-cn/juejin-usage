import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { AggregateCache } from '../src/aggregate-cache.js';
import { codexHomeCandidates } from '../src/paths.js';
import { loadCursors, loadRecentBuckets, resetCursorsCache } from '../src/queue/index.js';
import { BucketStore, createApplyAfterSync } from '../src/server/state.js';
import { syncCodex } from '../src/sync/index.js';
import type { TudConfig } from '../src/types.js';

function usage(timestamp: string, input: number, output: number): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5.4',
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
      },
    },
  }) + '\n';
}

async function writeSession(path: string, id: string, events: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd: '/fixture/backfill-project' },
  }) + '\n' + events);
}

test('restarted sync backfills appended and new Codex sessions across days and months exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T02:00:00.000Z') });
  const fixture = await mkdtemp(join(os.tmpdir(), 'jusage-recovery-backfill-'));
  const dataDir = join(fixture, 'usage');
  const codexDir = join(fixture, 'codex');
  const originalUsageHome = process.env.AI_USAGE_CODEX_HOME;
  const originalCodexOverride = process.env.CODEX_HOME;
  const homeMock = t.mock.method(os, 'homedir', () => fixture);
  syncBuiltinESMExports();
  process.env.AI_USAGE_CODEX_HOME = codexDir;
  delete process.env.CODEX_HOME;
  t.after(async () => {
    homeMock.mock.restore();
    syncBuiltinESMExports();
    if (originalUsageHome === undefined) delete process.env.AI_USAGE_CODEX_HOME;
    else process.env.AI_USAGE_CODEX_HOME = originalUsageHome;
    if (originalCodexOverride !== undefined) process.env.CODEX_HOME = originalCodexOverride;
    resetCursorsCache(dataDir);
    await rm(fixture, { recursive: true, force: true });
  });
  // Fail before parsing if discovery could see a developer's real sessions.
  assert.deepEqual(codexHomeCandidates(), [codexDir]);
  await mkdir(dataDir, { recursive: true });
  const config: TudConfig = {
    deviceId: 'recovery-fixture',
    hostname: 'fixture',
    dataDir,
    statsSince: '2026-11-01T00:00:00.000Z',
    localCollectSince: '2026-10-01T00:00:00.000Z',
    juejin: { enabled: false, apiUrl: 'https://usage.example.com', authMode: 'bearer', token: null },
  };
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config));
  const originalSession = join(codexDir, 'sessions/2026/10/30/rollout-existing.jsonl');
  await writeSession(originalSession, 'existing-session', usage('2026-10-30T10:00:00.000Z', 100, 20));

  const first = await syncCodex(dataDir, config);
  assert.equal(first.eventsParsed, 1);
  assert.equal(first.writtenBuckets[0]?.total_tokens, 120);
  const saved = await loadCursors(dataDir);
  assert.equal(saved.codex?.files[originalSession]?.offset, (await stat(originalSession)).size);
  const mainStore = new BucketStore();
  await mainStore.reload(dataDir, config.localCollectSince!);
  const mainCache = new AggregateCache(dataDir);
  await mainCache.rebuildFromRows(mainStore.getRows());
  const mainSummary = () => mainCache.getUsageSummary(mainStore.getRows(), config.localCollectSince!);
  assert.equal(mainSummary().totalTokens, 120);
  assert.equal(mainSummary().todayTokens, 0);

  // While the collector is down, an old session grows and new sessions appear.
  // The first append shares a bucket with data collected before the outage.
  await appendFile(originalSession,
    usage('2026-10-30T10:05:00.000Z', 25, 5) +
    usage('2026-10-31T10:00:00.000Z', 200, 20) +
    usage('2026-11-01T10:00:00.000Z', 300, 30));
  await writeSession(join(codexDir, 'sessions/2026/11/03/rollout-new.jsonl'), 'new-session',
    usage('2026-11-03T10:00:00.000Z', 400, 40));
  await writeSession(join(codexDir, 'sessions/2026/11/04/rollout-today.jsonl'), 'today-session',
    usage('2026-11-04T01:00:00.000Z', 500, 50));

  // A new worker has no in-memory cursors: it must resume from persisted state.
  resetCursorsCache(dataDir);
  const restartedConfig = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as TudConfig;
  const recovered = await syncCodex(dataDir, restartedConfig, {
    sharedCursors: await loadCursors(dataDir),
  });
  assert.equal(recovered.eventsParsed, 5);
  assert.equal(recovered.filesProcessed, 3);
  const rows = await loadRecentBuckets(dataDir, config.localCollectSince!);
  const daily = Object.fromEntries(rows.map((row) => [row.hour_start.slice(0, 10), row.total_tokens]));
  assert.deepEqual(daily, {
    '2026-10-30': 150,
    '2026-10-31': 220,
    '2026-11-01': 330,
    '2026-11-03': 440,
    '2026-11-04': 550,
  });
  const monthlyFiles = ['2026-10', '2026-11'].map((month) => join(dataDir, 'queue', `${month}.jsonl`));
  const queueBeforeRepeat = await Promise.all(monthlyFiles.map((path) => readFile(path, 'utf8')));

  resetCursorsCache(dataDir);
  const repeated = await syncCodex(dataDir, restartedConfig);
  assert.equal(repeated.eventsParsed, 0);
  assert.equal(repeated.bucketsWritten, 0);
  assert.deepEqual(await loadRecentBuckets(dataDir, config.localCollectSince!), rows);
  assert.deepEqual(await Promise.all(monthlyFiles.map((path) => readFile(path, 'utf8'))), queueBeforeRepeat);

  // The prior worker committed queue + cursors, then died before its syncDone
  // reached main. A replacement worker cannot re-emit those committed deltas.
  const applyAfterSync = createApplyAfterSync({
    getBucketStore: () => mainStore,
    getAggregateCache: () => mainCache,
  });
  await applyAfterSync([repeated]);
  assert.equal(mainSummary().totalTokens, 120);
  assert.equal(mainSummary().todayTokens, 0);

  // Reload alone restores live today, but old sealed dates are still stale.
  await mainStore.refresh(dataDir, config.localCollectSince!);
  assert.equal(mainSummary().todayTokens, 550);
  assert.equal(mainSummary().totalTokens, 670);
  await mainCache.rebuildFromRows(mainStore.getRows());
  assert.equal(mainSummary().totalTokens, 1690);
  assert.equal(mainSummary().todayTokens, 550);
  assert.deepEqual(Object.fromEntries(
    mainCache.getDaily(mainStore.getRows(), 7, config.localCollectSince!).days
      .map((day) => [day.date, day.tokens]),
  ), daily);
  assert.equal(mainCache.getHourly(mainStore.getRows(), 1, config.localCollectSince!).hours
    .reduce((sum, hour) => sum + hour.tokens, 0), 550);
});

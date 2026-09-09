import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { aggregateForIngest } from '../src/aggregate.js';
import { AggregateCache } from '../src/aggregate-cache.js';
import {
  aggregateLocalMetrics,
  localEvidence,
  mergeLocalEvidence,
  metricsFromBucket,
} from '../src/local-metrics.js';
import { alignUnknownIntoDominant } from '../src/queue/align-unknown.js';
import { bucketHash } from '../src/upload/state.js';
import { createLocalApiApp } from '../src/server/local-api.js';
import { BucketStore } from '../src/server/state.js';
import { loadConfig } from '../src/config.js';
import { addLocalDays, localDateNow } from '../src/timezone.js';
import type { QueueBucket } from '../src/types.js';

function pikaBucket(overrides: Partial<QueueBucket> = {}): QueueBucket {
  return {
    hour_start: `${localDateNow()}T02:00:00.000Z`,
    source: 'claude',
    model: 'pika-model',
    project: 'pika-project',
    input_tokens: 100,
    cached_input_tokens: 600,
    cache_creation_input_tokens: 300,
    output_tokens: 80,
    reasoning_output_tokens: 20,
    total_tokens: 1100,
    conversation_count: 1,
    local_metrics: localEvidence(1),
    ...overrides,
  };
}

test('pika local metrics use disjoint tokens and weighted cache ratios', () => {
  const metrics = metricsFromBucket(pikaBucket());
  assert.equal(metrics.requestCount, 1);
  assert.equal(metrics.cacheHitRate, 0.6);
  assert.equal(metrics.outputTokens + metrics.reasoningOutputTokens, 100);
  const weighted = aggregateLocalMetrics([
    pikaBucket({
      input_tokens: 10,
      cached_input_tokens: 90,
      cache_creation_input_tokens: 0,
    }),
    pikaBucket({
      input_tokens: 810,
      cached_input_tokens: 90,
      cache_creation_input_tokens: 0,
    }),
  ]);
  assert.equal(weighted.cacheHitRate, 0.18);
  assert.equal(weighted.requestCount, 2);
});

test('pika missing, invalid, legacy and zero usage remain distinct', () => {
  const legacy = pikaBucket({ local_metrics: undefined });
  assert.equal(metricsFromBucket(legacy).requestCount, null);
  assert.equal(metricsFromBucket(legacy).cacheHitRate, 0.6);
  const mixed = aggregateLocalMetrics([legacy, pikaBucket()]);
  assert.equal(mixed.requestCount, null);
  assert.equal(mixed.knownRequestCount, 1);
  assert.equal(
    metricsFromBucket(
      pikaBucket({ source: 'unknown', local_metrics: undefined }),
    ).cacheHitRate,
    null,
  );
  assert.equal(
    metricsFromBucket(pikaBucket({ input_tokens: -1 })).cacheReadTokens,
    null,
  );
  assert.equal(
    metricsFromBucket(pikaBucket({ input_tokens: Infinity }))
      .uncachedInputTokens,
    0,
  );
  const zero = pikaBucket({
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    conversation_count: 0,
    local_metrics: localEvidence(0),
  });
  assert.equal(metricsFromBucket(zero).requestCount, 0);
  assert.equal(metricsFromBucket(zero).cacheHitRate, null);
  assert.equal(
    metricsFromBucket(pikaBucket({ cached_input_tokens: 0 })).cacheHitRate,
    0,
  );
  assert.equal(
    mergeLocalEvidence(undefined, localEvidence(1)).requestCountComplete,
    false,
  );
});

test('pika unknown model alignment conserves request evidence and upload hashes ignore it', () => {
  const rows = [pikaBucket(), pikaBucket({ model: 'unknown' })];
  const aligned = alignUnknownIntoDominant(rows);
  assert.equal(aggregateLocalMetrics(aligned).requestCount, 2);
  const before = aggregateForIngest(rows);
  const after = aggregateForIngest(
    rows.map((row) => ({ ...row, local_metrics: localEvidence(99) })),
  );
  assert.deepEqual(before, after);
  assert.deepEqual(before.map(bucketHash), after.map(bucketHash));
  assert.ok(before.every((row) => !('local_metrics' in row)));
});

test('pika cached and uncached local API contracts agree after reload and metrics-only reseal', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pika-local-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const yesterday = addLocalDays(localDateNow(), -1);
  const rows = [
    pikaBucket(),
    pikaBucket({ hour_start: `${yesterday}T02:00:00.000Z` }),
    pikaBucket({
      hour_start: `${yesterday}T03:00:00.000Z`,
      source: 'cursor',
      local_metrics: undefined,
    }),
  ];
  const { config } = await loadConfig(dir);
  config.statsSince = '2020-01-01T00:00:00.000Z';
  config.localCollectSince = config.statsSince;
  const bucketStore = new BucketStore();
  bucketStore.apply(rows);
  const cache = new AggregateCache(dir);
  await cache.rebuildFromRows(rows);
  const reloaded = new AggregateCache(dir);
  await reloaded.ensureLoaded();
  const plain = createLocalApiApp({
    dataDir: dir,
    getConfig: () => config,
    bucketStore,
  });
  const cached = createLocalApiApp({
    dataDir: dir,
    getConfig: () => config,
    bucketStore,
    aggregateCache: reloaded,
  });
  const pikaCompare = async () => {
    for (const endpoint of [
      'usage-summary',
      'account-usage-summary',
      'usage-daily',
      'usage-hourly',
      'usage-model-breakdown',
    ]) {
      const path = `/functions/tud-${endpoint}?days=30`;
      const a = await plain.request(path);
      const b = await cached.request(path);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.deepEqual(await b.json(), await a.json(), endpoint);
    }
  };
  await pikaCompare();
  rows[1] = { ...rows[1]!, local_metrics: localEvidence(7) };
  bucketStore.apply([rows[1]]);
  await reloaded.onBucketsChanged(rows, [rows[1]]);
  await pikaCompare();
  assert.equal(
    reloaded
      .getDaily(rows, 30, config.statsSince)
      .days.find((row) => row.date === yesterday)
      ?.sources?.find((row) => row.source === 'claude')?.localMetrics
      ?.requestCount,
    7,
  );
});

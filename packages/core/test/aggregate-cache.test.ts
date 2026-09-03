import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AggregateCache, touchedLocalDates } from '../src/aggregate-cache.js';
import { addLocalDays, localDateNow } from '../src/timezone.js';
import type { QueueBucket } from '../src/types.js';

function makeRow(
  hourStart: string,
  totalTokens: number,
  source = 'codex',
  model = 'gpt-5',
  project = 'ai-usage',
): QueueBucket {
  return {
    hour_start: hourStart,
    source,
    model,
    project,
    input_tokens: totalTokens,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
    conversation_count: 1,
  };
}

test('touchedLocalDates collects unique local dates', () => {
  const today = localDateNow();
  const yesterday = addLocalDays(today, -1);
  const dates = touchedLocalDates([
    makeRow(`${yesterday}T02:00:00.000Z`, 10),
    makeRow(`${yesterday}T08:00:00.000Z`, 20),
  ]);
  assert.ok(dates.length >= 1);
});

test('AggregateCache seals history and serves daily without rescanning today-only changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-agg-cache-'));
  try {
    const today = localDateNow();
    const yesterday = addLocalDays(today, -1);
    const twoDaysAgo = addLocalDays(today, -2);

    const rows = [
      makeRow(`${twoDaysAgo}T04:00:00.000Z`, 100),
      makeRow(`${yesterday}T04:00:00.000Z`, 200),
      makeRow(`${today}T04:00:00.000Z`, 50),
    ];

    const cache = new AggregateCache(dir);
    await cache.rebuildFromRows(rows);
    assert.ok(cache.sealedDayCount() >= 1);

    const daily = cache.getDaily(rows, 30, '1970-01-01T00:00:00.000Z');
    const dates = daily.days.map((d) => d.date);
    assert.ok(dates.includes(yesterday) || dates.includes(twoDaysAgo));
    assert.ok(dates.includes(today));

    const before = cache.sealedDayCount();
    // Today-only apply must not grow sealed history.
    await cache.onBucketsChanged(rows, [
      makeRow(`${today}T06:00:00.000Z`, 75),
    ]);
    assert.equal(cache.sealedDayCount(), before);

    const raw = await readFile(join(dir, 'cache', 'daily-sealed.json'), 'utf8');
    assert.ok(raw.includes('"version":3'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AggregateCache reseals only touched historical dates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-agg-reseal-'));
  try {
    const today = localDateNow();
    const yesterday = addLocalDays(today, -1);

    const rows = [makeRow(`${yesterday}T04:00:00.000Z`, 100)];
    const cache = new AggregateCache(dir);
    await cache.rebuildFromRows(rows);

    const updated = [makeRow(`${yesterday}T04:00:00.000Z`, 999)];
    await cache.onBucketsChanged(updated, updated);

    const daily = cache.getDaily(updated, 7, '1970-01-01T00:00:00.000Z');
    const y = daily.days.find((d) => d.date === yesterday);
    assert.ok(y);
    assert.equal(y.tokens, 999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AggregateCache merge keeps 8-decimal costs so two 4.516 days do not become 9.04', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-agg-cost-'));
  try {
    const today = localDateNow();
    const yesterday = addLocalDays(today, -1);
    const twoDaysAgo = addLocalDays(today, -2);

    const rows: QueueBucket[] = [
      {
        hour_start: `${twoDaysAgo}T04:00:00.000Z`,
        source: 'cursor',
        model: 'composer-1',
        project: 'ai-usage',
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 1,
        conversation_count: 1,
        reported_cost_usd: 4.516,
      },
      {
        hour_start: `${yesterday}T04:00:00.000Z`,
        source: 'cursor',
        model: 'composer-1',
        project: 'ai-usage',
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 1,
        conversation_count: 1,
        reported_cost_usd: 4.516,
      },
    ];

    const cache = new AggregateCache(dir);
    await cache.rebuildFromRows(rows);
    const breakdown = cache.getModelBreakdown(
      rows,
      30,
      '1970-01-01T00:00:00.000Z',
    );
    assert.equal(breakdown.models.length, 1);
    assert.equal(breakdown.models[0]?.costUsd, 9.032);
    assert.notEqual(breakdown.models[0]?.costUsd, 9.04);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

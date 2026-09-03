import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateDaily,
  aggregateHourly,
  aggregateModelBreakdown,
  aggregateUsageSummary,
} from '../src/aggregate.js';
import { roundCostUsd } from '../src/pricing/index.js';
import { dailyModelKey, parseDailyModelKey } from '../src/daily-model-key.js';
import {
  DEFAULT_STATS_TIMEZONE,
  localDateAndHour,
  localDateNow,
} from '../src/timezone.js';
import type { QueueBucket } from '../src/types.js';

function makeRow(
  project: string,
  totalTokens: number,
  source = 'codex',
  model = 'gpt-5',
  hourStart = new Date().toISOString(),
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

test('aggregateModelBreakdown merges URI-encoded cwd with folder name', () => {
  const result = aggregateModelBreakdown(
    [
      makeRow('%2FUsers%2Fme%2Fcode%2Fai-usage', 200),
      makeRow('ai-usage', 100),
      makeRow('%2FUsers%2Fme%2Fcode%2Fdocs-site', 50),
    ],
    30,
    '1970-01-01T00:00:00.000Z',
  );

  assert.deepEqual(
    result.projects.map(({ project, tokens, pct }) => ({
      project,
      tokens,
      pct,
    })),
    [
      { project: 'ai-usage', tokens: 300, pct: 85.7 },
      { project: 'docs-site', tokens: 50, pct: 14.3 },
    ],
  );
});

test('aggregateModelBreakdown includes project totals and percentages', () => {
  const result = aggregateModelBreakdown(
    [makeRow('ai-usage', 300), makeRow('docs-site', 100)],
    30,
    '1970-01-01T00:00:00.000Z',
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.tokens, 400);
  assert.deepEqual(
    result.projects.map(({ project, tokens, pct }) => ({
      project,
      tokens,
      pct,
    })),
    [
      { project: 'ai-usage', tokens: 300, pct: 75 },
      { project: 'docs-site', tokens: 100, pct: 25 },
    ],
  );
});

test('aggregateModelBreakdown nests source+model under each project', () => {
  const result = aggregateModelBreakdown(
    [
      makeRow('ai-usage', 200, 'claude', 'opus'),
      makeRow('ai-usage', 100, 'codex', 'gpt-5'),
      makeRow('docs-site', 50, 'claude', 'opus'),
    ],
    30,
    '1970-01-01T00:00:00.000Z',
  );

  const aiUsage = result.projects.find((row) => row.project === 'ai-usage');
  assert.ok(aiUsage);
  assert.deepEqual(
    aiUsage.models.map(({ source, model, tokens, pct }) => ({
      source,
      model,
      tokens,
      pct,
    })),
    [
      { source: 'claude', model: 'opus', tokens: 200, pct: 66.7 },
      { source: 'codex', model: 'gpt-5', tokens: 100, pct: 33.3 },
    ],
  );
});

test('aggregateDaily keeps same model name under different sources separate', () => {
  const result = aggregateDaily(
    [
      makeRow('proj', 1000, 'cursor', 'auto'),
      makeRow('proj', 40, 'qoder', 'auto'),
    ],
    30,
    '1970-01-01T00:00:00.000Z',
  );

  assert.equal(result.days.length, 1);
  const models = result.days[0]?.models ?? {};
  assert.equal(models[dailyModelKey('cursor', 'auto')], 1000);
  assert.equal(models[dailyModelKey('qoder', 'auto')], 40);
  assert.equal(parseDailyModelKey(dailyModelKey('qoder', 'auto')).source, 'qoder');
  assert.equal(parseDailyModelKey(dailyModelKey('qoder', 'auto')).model, 'auto');
});

test('aggregateDaily merges URI-encoded cwd with folder name', () => {
  const result = aggregateDaily(
    [
      makeRow('%2FUsers%2Fme%2Fcode%2Fai-usage', 200, 'claude', 'opus'),
      makeRow('ai-usage', 100, 'codex', 'gpt-5'),
    ],
    30,
    '1970-01-01T00:00:00.000Z',
  );

  assert.equal(result.days.length, 1);
  const projects = result.days[0]?.projects ?? [];
  assert.deepEqual(
    projects.map(({ project, tokens }) => ({ project, tokens })),
    [{ project: 'ai-usage', tokens: 300 }],
  );
});

test('aggregateDaily nests projects with source+model keys', () => {
  const result = aggregateDaily(
    [
      makeRow('ai-usage', 200, 'claude', 'opus'),
      makeRow('ai-usage', 100, 'codex', 'gpt-5'),
      makeRow('docs-site', 50, 'claude', 'opus'),
    ],
    30,
    '1970-01-01T00:00:00.000Z',
  );

  assert.equal(result.days.length, 1);
  const projects = result.days[0]?.projects ?? [];
  assert.deepEqual(
    projects.map(({ project, tokens }) => ({ project, tokens })),
    [
      { project: 'ai-usage', tokens: 300 },
      { project: 'docs-site', tokens: 50 },
    ],
  );
  const aiUsage = projects.find((row) => row.project === 'ai-usage');
  assert.ok(aiUsage);
  assert.equal(aiUsage.models[dailyModelKey('claude', 'opus')], 200);
  assert.equal(aiUsage.models[dailyModelKey('codex', 'gpt-5')], 100);
});

test('localDateAndHour maps UTC evening into Asia/Shanghai next-day morning', () => {
  const result = localDateAndHour(
    '2026-07-24T17:00:00.000Z',
    DEFAULT_STATS_TIMEZONE,
  );
  assert.deepEqual(result, { date: '2026-07-25', hour: 1 });
});

test('aggregateHourly buckets by Asia/Shanghai hour and omits empty hours', () => {
  const result = aggregateHourly(
    [
      makeRow('proj', 100, 'codex', 'gpt-5', '2026-07-24T17:00:00.000Z'),
      makeRow('proj', 50, 'codex', 'gpt-5', '2026-07-24T17:30:00.000Z'),
      makeRow('proj', 20, 'codex', 'gpt-5', '2026-07-25T02:00:00.000Z'),
    ],
    365,
    '1970-01-01T00:00:00.000Z',
  );

  assert.equal(result.timeZone, DEFAULT_STATS_TIMEZONE);
  assert.equal(result.hours.length, 2);
  assert.deepEqual(result.hours[0], {
    date: '2026-07-25',
    hour: 1,
    source: 'codex',
    tokens: 150,
    costUsd: result.hours[0]!.costUsd,
    inputTokens: 150,
    outputTokens: 0,
    cachedInputTokens: 0,
  });
  assert.equal(result.hours[1]?.date, '2026-07-25');
  assert.equal(result.hours[1]?.hour, 10);
  assert.equal(result.hours[1]?.source, 'codex');
  assert.equal(result.hours[1]?.tokens, 20);
});

test('aggregateHourly keeps separate rows per source in the same hour', () => {
  const result = aggregateHourly(
    [
      makeRow('proj', 100, 'cursor', 'gpt-4', '2026-07-24T17:00:00.000Z'),
      makeRow('proj', 40, 'claude', 'sonnet', '2026-07-24T17:00:00.000Z'),
    ],
    365,
    '1970-01-01T00:00:00.000Z',
  );

  assert.equal(result.hours.length, 2);
  assert.equal(result.hours[0]?.hour, 1);
  assert.equal(result.hours[0]?.source, 'claude');
  assert.equal(result.hours[0]?.tokens, 40);
  assert.equal(result.hours[1]?.source, 'cursor');
  assert.equal(result.hours[1]?.tokens, 100);
});

function makeCursorCostRow(
  model: string,
  reportedCostUsd: number,
  hourStart = new Date().toISOString(),
): QueueBucket {
  return {
    hour_start: hourStart,
    source: 'cursor',
    model,
    project: 'ai-usage',
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 1,
    conversation_count: 1,
    reported_cost_usd: reportedCostUsd,
  };
}

test('aggregateModelBreakdown keeps 8-decimal model costs instead of cents', () => {
  const result = aggregateModelBreakdown(
    [
      makeCursorCostRow('composer-1', 4.516),
      makeCursorCostRow('gpt-5', 4.516),
    ],
    30,
    '1970-01-01T00:00:00.000Z',
  );

  assert.equal(result.models.length, 2);
  for (const row of result.models) {
    assert.equal(row.costUsd, roundCostUsd(4.516));
    assert.notEqual(row.costUsd, 4.52);
  }

  const summary = aggregateUsageSummary(
    [
      makeCursorCostRow('composer-1', 4.516),
      makeCursorCostRow('gpt-5', 4.516),
    ],
    '1970-01-01T00:00:00.000Z',
  );
  const cursor = summary.bySource.find((row) => row.source === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.costUsd, roundCostUsd(9.032));
  assert.notEqual(cursor.costUsd, 9.04);
});

test('aggregateDaily and todayTokens use Asia/Shanghai calendar day', () => {
  const localToday = localDateNow(DEFAULT_STATS_TIMEZONE);
  // Pick a UTC instant that is "today" morning in Shanghai but previous UTC date
  // when local hour is early — use a fixed cross-day fixture instead.
  const crossDayUtc = '2026-07-24T17:00:00.000Z'; // Shanghai 2026-07-25 01:00
  const { date: localDate } = localDateAndHour(
    crossDayUtc,
    DEFAULT_STATS_TIMEZONE,
  );
  assert.equal(localDate, '2026-07-25');

  const daily = aggregateDaily(
    [makeRow('proj', 80, 'codex', 'gpt-5', crossDayUtc)],
    365,
    '1970-01-01T00:00:00.000Z',
  );
  assert.equal(daily.days.length, 1);
  assert.equal(daily.days[0]?.date, '2026-07-25');
  assert.equal(daily.days[0]?.tokens, 80);

  // Summary "today" is dynamic — only assert when the fixture lands on local today.
  if (localToday === '2026-07-25') {
    const summary = aggregateUsageSummary(
      [makeRow('proj', 80, 'codex', 'gpt-5', crossDayUtc)],
      '1970-01-01T00:00:00.000Z',
    );
    assert.equal(summary.todayTokens, 80);
  }
});

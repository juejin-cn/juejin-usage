import assert from 'node:assert/strict';
import test from 'node:test';

import { dailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import {
  addLocalDays,
  localDateNow,
} from '@juejin-opensource/jusage-core/timezone';

import type { UsageDataset } from './api.ts';
import {
  buildDashboardDataFromDataset,
  buildFilledHourlyForDate,
  projectDashboardForDate,
} from './dashboard-data.ts';
import { buildToolModelUsage } from './dashboard-mock-data.ts';

function datasetWithDays(
  dailyRows: UsageDataset['dailyRows'],
  extras: Partial<UsageDataset> = {},
): UsageDataset {
  return {
    summary: {
      totalTokens: dailyRows.reduce((sum, row) => sum + row.tokens, 0),
      totalCostUsd: dailyRows.reduce((sum, row) => sum + row.costUsd, 0),
      todayTokens: 0,
      todayCostUsd: 0,
      statsSince: '2026-01-01',
      bySource: [],
    },
    dailyRows,
    hourlyRows: [],
    modelRows: [],
    projectRows: [],
    syncStatus: null,
    ...extras,
  };
}

test('today range stays zero when only yesterday has usage', () => {
  const today = localDateNow();
  const yesterday = addLocalDays(today, -1);
  const dataset = datasetWithDays([
    {
      date: yesterday,
      tokens: 12_000,
      costUsd: 1.25,
      models: { 'gpt-4': 12_000 },
    },
  ]);

  const view = buildDashboardDataFromDataset(dataset, 1);

  assert.equal(view.summary.totalTokens, 0);
  assert.equal(view.summary.totalCostUsd, 0);
  assert.equal(view.rangeDailyUsage.length, 0);
  assert.ok(view.todayHourlyUsage.length > 0);
  assert.ok(view.todayHourlyUsage.every((row) => row.totalTokens === 0));
  assert.equal(view.heatmapDays.length, 1);
  assert.equal(view.heatmapDays[0]?.date, yesterday);
  assert.deepEqual(view.distributions.tools, []);
  assert.deepEqual(view.distributions.models, []);
});

test('last-7-days includes yesterday but not days outside the calendar window', () => {
  const today = localDateNow();
  const yesterday = addLocalDays(today, -1);
  const eightDaysAgo = addLocalDays(today, -8);
  const dataset = datasetWithDays([
    {
      date: eightDaysAgo,
      tokens: 99_000,
      costUsd: 9,
      models: {},
    },
    {
      date: yesterday,
      tokens: 5_000,
      costUsd: 0.5,
      models: {},
    },
  ]);

  const view = buildDashboardDataFromDataset(dataset, 7);

  assert.equal(view.summary.totalTokens, 5_000);
  assert.equal(view.rangeDailyUsage.length, 1);
  assert.equal(view.rangeDailyUsage[0]?.date, yesterday);
});

test('projectDashboardForDate builds project usage from that day projects', () => {
  const today = localDateNow();
  const yesterday = addLocalDays(today, -1);
  const claudeOpus = dailyModelKey('claude', 'opus');
  const codexGpt = dailyModelKey('codex', 'gpt-5');

  const dataset = datasetWithDays(
    [
      {
        date: yesterday,
        tokens: 300,
        costUsd: 3,
        models: { [claudeOpus]: 200, [codexGpt]: 100 },
        projects: [
          {
            project: 'ai-usage',
            tokens: 300,
            models: { [claudeOpus]: 200, [codexGpt]: 100 },
          },
        ],
      },
      {
        date: addLocalDays(today, -2),
        tokens: 50,
        costUsd: 0.5,
        models: { [claudeOpus]: 50 },
        projects: [
          {
            project: 'docs-site',
            tokens: 50,
            models: { [claudeOpus]: 50 },
          },
        ],
      },
    ],
    {
      projectRows: [
        {
          project: 'ai-usage',
          tokens: 300,
          costUsd: 3,
          pct: 85.7,
          models: [
            {
              model: 'opus',
              source: 'claude',
              tokens: 200,
              costUsd: 2,
              pct: 66.7,
            },
            {
              model: 'gpt-5',
              source: 'codex',
              tokens: 100,
              costUsd: 1,
              pct: 33.3,
            },
          ],
        },
        {
          project: 'docs-site',
          tokens: 50,
          costUsd: 0.5,
          pct: 14.3,
          models: [
            {
              model: 'opus',
              source: 'claude',
              tokens: 50,
              costUsd: 0.5,
              pct: 100,
            },
          ],
        },
      ],
    },
  );

  const rangeView = buildDashboardDataFromDataset(dataset, 7);
  assert.equal(rangeView.projectModelUsage.length, 2);

  const dayView = projectDashboardForDate(rangeView, yesterday);
  assert.equal(dayView.projectModelUsage.length, 1);
  assert.equal(dayView.projectModelUsage[0]?.project, 'ai-usage');
  assert.equal(dayView.projectModelUsage[0]?.tokens, 300);
  assert.equal(dayView.projectModelUsage[0]?.models.length, 2);
  assert.ok(
    dayView.distributions.projects.some((row) => row.label === 'ai-usage'),
  );
  assert.ok(
    !dayView.distributions.projects.some((row) => row.label === 'docs-site'),
  );
});

test('project usage decodes URI-encoded cwd and merges with folder name', () => {
  const today = localDateNow();
  const yesterday = addLocalDays(today, -1);
  const dataset = datasetWithDays(
    [
      {
        date: yesterday,
        tokens: 300,
        costUsd: 3,
        models: {},
        projects: [
          {
            project: '%2FUsers%2Fme%2Fcode%2Fai-usage',
            tokens: 200,
            models: { [dailyModelKey('grok', 'grok-4')]: 200 },
          },
          {
            project: 'ai-usage',
            tokens: 100,
            models: { [dailyModelKey('codex', 'gpt-5')]: 100 },
          },
        ],
      },
    ],
    {
      projectRows: [
        {
          project: '%2FUsers%2Fme%2Fcode%2Fai-usage',
          tokens: 200,
          costUsd: 2,
          pct: 66.7,
          models: [
            {
              model: 'grok-4',
              source: 'grok',
              tokens: 200,
              costUsd: 2,
              pct: 100,
            },
          ],
        },
        {
          project: 'ai-usage',
          tokens: 100,
          costUsd: 1,
          pct: 33.3,
          models: [
            {
              model: 'gpt-5',
              source: 'codex',
              tokens: 100,
              costUsd: 1,
              pct: 100,
            },
          ],
        },
      ],
    },
  );

  const rangeView = buildDashboardDataFromDataset(dataset, 7);
  assert.equal(rangeView.projectModelUsage.length, 1);
  assert.equal(rangeView.projectModelUsage[0]?.project, 'ai-usage');
  assert.equal(rangeView.projectModelUsage[0]?.label, 'ai-usage');
  assert.equal(rangeView.projectModelUsage[0]?.tokens, 300);
  assert.equal(rangeView.projectModelUsage[0]?.models.length, 2);
  assert.ok(
    rangeView.distributions.projects.some((row) => row.label === 'ai-usage'),
  );
  assert.ok(
    !rangeView.distributions.projects.some((row) => row.label.includes('%2F')),
  );

  const dayView = projectDashboardForDate(rangeView, yesterday);
  assert.equal(dayView.projectModelUsage.length, 1);
  assert.equal(dayView.projectModelUsage[0]?.project, 'ai-usage');
  assert.equal(dayView.projectModelUsage[0]?.tokens, 300);
});

test('projectDashboardForDate keeps empty project usage when day has no projects', () => {
  const today = localDateNow();
  const yesterday = addLocalDays(today, -1);
  const dataset = datasetWithDays([
    {
      date: yesterday,
      tokens: 100,
      costUsd: 1,
      models: { 'gpt-4': 100 },
    },
  ]);

  const rangeView = buildDashboardDataFromDataset(dataset, 7);
  const dayView = projectDashboardForDate(rangeView, yesterday);
  assert.deepEqual(dayView.projectModelUsage, []);
  assert.deepEqual(dayView.distributions.projects, []);
});

test('buildFilledHourlyForDate matches ISO midnight dates to YYYY-MM-DD', () => {
  const rows = buildFilledHourlyForDate(
    [
      {
        date: '2026-08-13T00:00:00.000Z',
        hour: 10,
        source: 'claude',
        tokens: 1_000,
        costUsd: 0.1,
        inputTokens: 800,
        outputTokens: 200,
        cachedInputTokens: 0,
      },
      {
        date: '2026-08-12T00:00:00.000Z',
        hour: 9,
        source: 'claude',
        tokens: 50,
        costUsd: 0.01,
        inputTokens: 40,
        outputTokens: 10,
        cachedInputTokens: 0,
      },
    ],
    '2026-08-13',
  );

  assert.equal(rows[10]?.totalTokens, 1_000);
  assert.equal(rows[9]?.totalTokens, 0);
});

test('buildFilledHourlyForDate coerces hour strings', () => {
  const rows = buildFilledHourlyForDate(
    [
      {
        date: '2026-08-13',
        hour: '14' as unknown as number,
        source: 'codex',
        tokens: 200,
        costUsd: 0.02,
        inputTokens: 150,
        outputTokens: 50,
        cachedInputTokens: 0,
      },
    ],
    '2026-08-13',
  );

  assert.equal(rows[14]?.totalTokens, 200);
});

test('projectDashboardForDate fills hourly from ISO date rows', () => {
  const today = localDateNow();
  const yesterday = addLocalDays(today, -1);
  const dataset = datasetWithDays(
    [
      {
        date: yesterday,
        tokens: 500,
        costUsd: 1,
        models: { 'gpt-4': 500 },
      },
    ],
    {
      hourlyRows: [
        {
          date: `${yesterday}T00:00:00.000Z`,
          hour: 9,
          source: 'claude',
          tokens: 500,
          costUsd: 1,
          inputTokens: 400,
          outputTokens: 100,
          cachedInputTokens: 0,
        },
      ],
    },
  );

  const rangeView = buildDashboardDataFromDataset(dataset, 7);
  const dayView = projectDashboardForDate(rangeView, yesterday);
  assert.equal(dayView.todayHourlyUsage[9]?.totalTokens, 500);
});

test('buildToolModelUsage rounds the source total once, not per model then sum', () => {
  const rows = buildToolModelUsage(
    [
      {
        source: 'cursor',
        tokens: 2,
        costUsd: 4.516 + 4.516,
        models: [
          { model: 'composer-1', tokens: 1, costUsd: 4.516 },
          { model: 'gpt-5', tokens: 1, costUsd: 4.516 },
        ],
      },
    ],
    2,
  );

  assert.equal(rows[0]?.costUsd, 9.03);
  assert.notEqual(rows[0]?.costUsd, 9.04);
  assert.equal(rows[0]?.models[0]?.costUsd, 4.52);
  assert.equal(rows[0]?.models[1]?.costUsd, 4.52);
});

test('dashboard tool panel uses summed 8-decimal model costs then cents', () => {
  const today = localDateNow();
  const dataset = datasetWithDays(
    [
      {
        date: today,
        tokens: 2,
        costUsd: 9.032,
        models: {},
      },
    ],
    {
      modelRows: [
        {
          model: 'composer-1',
          source: 'cursor',
          tokens: 1,
          costUsd: 4.516,
          pct: 50,
        },
        {
          model: 'gpt-5',
          source: 'cursor',
          tokens: 1,
          costUsd: 4.516,
          pct: 50,
        },
      ],
    },
  );

  const view = buildDashboardDataFromDataset(dataset, 30);
  assert.equal(view.toolModelUsage[0]?.source, 'cursor');
  assert.equal(view.toolModelUsage[0]?.costUsd, 9.03);
  assert.notEqual(view.toolModelUsage[0]?.costUsd, 9.04);
});

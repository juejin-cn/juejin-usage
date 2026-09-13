import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import type { DailyUsageRow, HourlyUsageRow, ModelBreakdownRow } from './api.ts';
import type {
  DashboardDailyUsageRow,
  DashboardHourlyUsageRow,
  DashboardToolUsageRow,
} from './dashboard-mock-data.ts';
import {
  buildVisibleMetricTrends,
  buildToolModelDistributions,
  filterHeatmapDaysBySources,
  filterProjectRowsBySources,
  filterTrendRowsBySources,
  summarizeTrendRows,
} from './usage-filter.ts';

const dailyRow = (
  date: string,
  totalTokens: number,
): DashboardDailyUsageRow => ({
  day: '周一',
  date,
  dateLabel: date,
  inputTokens: Math.round(totalTokens * 0.6),
  cachedInputTokens: Math.round(totalTokens * 0.1),
  cacheCreationInputTokens: 0,
  uncachedInputTokens: Math.round(totalTokens * 0.5),
  outputTokens: Math.round(totalTokens * 0.4),
  totalTokens,
  costUsd: totalTokens / 1_000_000,
  durationMinutes: 10,
});

const hourlyRow = (
  hour: number,
  totalTokens: number,
): DashboardHourlyUsageRow => ({
  day: '周一',
  hour,
  hourLabel: String(hour).padStart(2, '0'),
  inputTokens: Math.round(totalTokens * 0.6),
  cachedInputTokens: Math.round(totalTokens * 0.1),
  outputTokens: Math.round(totalTokens * 0.4),
  totalTokens,
  costUsd: totalTokens / 1_000_000,
  durationMinutes: 1,
});

const apiHourlyRow = (
  date: string,
  hour: number,
  source: string,
  tokens: number,
): HourlyUsageRow => ({
  date,
  hour,
  source,
  tokens,
  costUsd: tokens / 1_000_000,
  inputTokens: Math.round(tokens * 0.6),
  outputTokens: Math.round(tokens * 0.4),
  cachedInputTokens: Math.round(tokens * 0.1),
});

describe('filterTrendRowsBySources', () => {
  const heatmapDays: DailyUsageRow[] = [
    {
      date: '2026-07-28',
      tokens: 1000,
      costUsd: 0.001,
      models: {
        [dailyModelKey('cursor', 'gpt-4')]: 700,
        [dailyModelKey('claude', 'sonnet')]: 300,
      },
    },
  ];
  const modelRows: ModelBreakdownRow[] = [
    {
      model: 'gpt-4',
      source: 'cursor',
      tokens: 700,
      costUsd: 0.0007,
      pct: 70,
    },
    {
      model: 'sonnet',
      source: 'claude',
      tokens: 300,
      costUsd: 0.0003,
      pct: 30,
    },
  ];
  const toolRows: DashboardToolUsageRow[] = [
    {
      source: 'cursor',
      tokens: 700,
      costUsd: 0.0007,
      pct: 70,
      models: [{ model: 'gpt-4', tokens: 700, costUsd: 0.0007, pct: 100 }],
    },
    {
      source: 'claude',
      tokens: 300,
      costUsd: 0.0003,
      pct: 30,
      models: [{ model: 'sonnet', tokens: 300, costUsd: 0.0003, pct: 100 }],
    },
  ];
  const hourlyApiRows: HourlyUsageRow[] = [
    apiHourlyRow('2026-07-28', 9, 'cursor', 100),
    apiHourlyRow('2026-07-28', 10, 'claude', 300),
  ];
  const filledHourly = [hourlyRow(9, 100), hourlyRow(10, 300)];

  it('returns original rows when no sources selected', () => {
    const dailyRows = [dailyRow('2026-07-28', 1000)];
    const result = filterTrendRowsBySources({
      dailyRows,
      hourlyRows: filledHourly,
      hourlyApiRows,
      hourlyDate: '2026-07-28',
      heatmapDays,
      modelRows,
      toolRows,
      selectedSources: [],
    });
    assert.equal(result.dailyRows, dailyRows);
    assert.equal(result.hourlyRows, filledHourly);
  });

  it('scales daily rows by selected channel share', () => {
    const result = filterTrendRowsBySources({
      dailyRows: [dailyRow('2026-07-28', 1000)],
      hourlyRows: filledHourly,
      hourlyApiRows,
      hourlyDate: '2026-07-28',
      heatmapDays,
      modelRows,
      toolRows,
      selectedSources: ['cursor'],
    });

    assert.equal(result.dailyRows[0]?.totalTokens, 700);
  });

  it('filters hourly rows by source instead of scaling every hour', () => {
    const result = filterTrendRowsBySources({
      dailyRows: [dailyRow('2026-07-28', 1000)],
      hourlyRows: filledHourly,
      hourlyApiRows,
      hourlyDate: '2026-07-28',
      heatmapDays,
      modelRows,
      toolRows,
      selectedSources: ['claude'],
    });

    assert.equal(
      result.hourlyRows.find((row) => row.hour === 9)?.totalTokens,
      0,
    );
    assert.equal(
      result.hourlyRows.find((row) => row.hour === 10)?.totalTokens,
      300,
    );
  });

  it('zeros hourly rows when selected channel has no usage that hour', () => {
    const result = filterTrendRowsBySources({
      dailyRows: [dailyRow('2026-07-28', 1000)],
      hourlyRows: filledHourly,
      hourlyApiRows,
      hourlyDate: '2026-07-28',
      heatmapDays,
      modelRows,
      toolRows,
      selectedSources: ['codex'],
    });

    assert.equal(result.dailyRows[0]?.totalTokens, 0);
    assert.equal(result.hourlyRows[0]?.totalTokens, 0);
    assert.equal(result.hourlyRows[1]?.totalTokens, 0);
  });
});

describe('dashboard card and trend consistency', () => {
  const cursorModel = dailyModelKey('cursor', 'gpt-4');
  const claudeModel = dailyModelKey('claude', 'sonnet');
  const modelRows: ModelBreakdownRow[] = [
    { model: 'gpt-4', source: 'cursor', tokens: 700, costUsd: 0.7, pct: 70 },
    { model: 'sonnet', source: 'claude', tokens: 300, costUsd: 0.3, pct: 30 },
  ];
  const toolRows: DashboardToolUsageRow[] = [
    {
      source: 'cursor',
      tokens: 700,
      costUsd: 0.7,
      pct: 70,
      models: [{ model: 'gpt-4', tokens: 700, costUsd: 0.7, pct: 100 }],
    },
    {
      source: 'claude',
      tokens: 300,
      costUsd: 0.3,
      pct: 30,
      models: [{ model: 'sonnet', tokens: 300, costUsd: 0.3, pct: 100 }],
    },
  ];

  it('builds card totals from the exact rendered trend rows', () => {
    const summary = summarizeTrendRows({
      dailyRows: [dailyRow('2026-07-13', 300), dailyRow('2026-07-14', 700)],
      hourlyRows: [],
      hourly: false,
    });
    assert.equal(summary.totalTokens, 1000);
    assert.equal(summary.inputTokens, 600);
    assert.equal(summary.outputTokens, 400);
  });

  it('compares a filtered range with the preceding equal range', () => {
    const previousDate = '2026-07-07';
    const heatmapDays: DailyUsageRow[] = [
      {
        date: previousDate,
        tokens: 500,
        costUsd: 0.5,
        models: { [cursorModel]: 350, [claudeModel]: 150 },
      },
    ];
    const trends = buildVisibleMetricTrends({
      currentDailyRows: [dailyRow('2026-07-14', 700)],
      currentHourlyRows: [],
      heatmapDailyRows: [dailyRow(previousDate, 500)],
      heatmapDays,
      hourlyApiRows: [],
      modelRows,
      toolRows,
      selectedSources: ['cursor'],
      rangeDays: 7,
      hourly: false,
      currentDate: '2026-07-14',
    });
    assert.equal(trends.totalTokens?.changePct, 100);
    assert.equal(trends.totalTokens?.changeValue, 350);
  });

  it('compares today with the same hours yesterday', () => {
    const trends = buildVisibleMetricTrends({
      currentDailyRows: [],
      currentHourlyRows: [hourlyRow(9, 200)],
      heatmapDailyRows: [],
      heatmapDays: [],
      hourlyApiRows: [apiHourlyRow('2026-07-13T00:00:00.000Z', 9, 'cursor', 100)],
      modelRows,
      toolRows,
      selectedSources: ['cursor'],
      rangeDays: 1,
      hourly: true,
      currentDate: '2026-07-14',
    });
    assert.equal(trends.totalTokens?.changePct, 100);
    assert.equal(trends.totalTokens?.changeValue, 100);
  });

  it('filters heatmap totals and model details together', () => {
    const [day] = filterHeatmapDaysBySources(
      [{
        date: '2026-07-14',
        tokens: 1000,
        costUsd: 1,
        models: { [cursorModel]: 700, [claudeModel]: 300 },
      }],
      ['cursor'],
      modelRows,
    );
    assert.equal(day?.tokens, 700);
    assert.equal(day?.costUsd, 0.7);
    assert.deepEqual(day?.models, { [cursorModel]: 700 });
  });
});

describe('filterProjectRowsBySources', () => {
  const rows = [
    {
      project: 'ai-usage',
      label: 'ai-usage',
      tokens: 1000,
      costUsd: 0.01,
      pct: 50,
      models: [
        {
          model: 'gpt-4',
          source: 'cursor',
          tokens: 700,
          costUsd: 0.007,
          pct: 70,
        },
        {
          model: 'sonnet',
          source: 'claude',
          tokens: 300,
          costUsd: 0.003,
          pct: 30,
        },
      ],
    },
    {
      project: 'unknown',
      label: '未知项目',
      tokens: 1000,
      costUsd: 0.01,
      pct: 50,
      models: [
        {
          model: 'gpt-4',
          source: 'cursor',
          tokens: 1000,
          costUsd: 0.01,
          pct: 100,
        },
      ],
    },
  ];

  it('returns original rows when no sources selected', () => {
    assert.equal(filterProjectRowsBySources(rows, []), rows);
  });

  it('keeps matching models and drops empty projects', () => {
    const result = filterProjectRowsBySources(rows, ['claude']);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.project, 'ai-usage');
    assert.equal(result[0]?.tokens, 300);
    assert.equal(result[0]?.models.length, 1);
    assert.equal(result[0]?.models[0]?.source, 'claude');
  });
});

describe('buildToolModelDistributions', () => {
  const toolRows = [
    {
      source: 'roocode',
      tokens: 400,
      costUsd: 0.004,
      pct: 40,
      models: [
        { model: 'sonnet', tokens: 250, costUsd: 0.0025, pct: 62.5 },
        { model: 'haiku', tokens: 150, costUsd: 0.0015, pct: 37.5 },
      ],
    },
    {
      source: 'cursor',
      tokens: 600,
      costUsd: 0.006,
      pct: 60,
      models: [
        { model: 'gpt-4', tokens: 600, costUsd: 0.006, pct: 100 },
      ],
    },
  ];

  it('uses source keys as tool ids (not slugified labels)', () => {
    const { tools } = buildToolModelDistributions(toolRows);
    assert.equal(tools.find((row) => row.id === 'roocode')?.tokens, 400);
    assert.ok(tools.every((row) => row.id === 'roocode' || row.id === 'cursor'));
  });

  it('assigns distinct chart colors by rank for models in one channel', () => {
    const { models } = buildToolModelDistributions(
      toolRows.filter((row) => row.source === 'roocode'),
    );
    assert.equal(models.length, 2);
    assert.equal(models[0]?.color, 'var(--chart-1)');
    assert.equal(models[1]?.color, 'var(--chart-2)');
    assert.notEqual(models[0]?.color, models[1]?.color);
  });

  it('keeps token totals equal to visible tool rows', () => {
    const visible = toolRows.filter((row) => row.source === 'roocode');
    const { tools, models } = buildToolModelDistributions(visible);
    const toolSum = tools.reduce((sum, row) => sum + row.tokens, 0);
    const modelSum = models.reduce((sum, row) => sum + row.tokens, 0);
    const visibleSum = visible.reduce((sum, row) => sum + row.tokens, 0);
    assert.equal(toolSum, visibleSum);
    assert.equal(modelSum, visibleSum);
  });
});

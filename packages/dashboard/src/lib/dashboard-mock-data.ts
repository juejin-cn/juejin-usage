import { normalizeProjectName } from '@juejin-opensource/jusage-core/project-label';
import type { DailyUsageRow, HourlyUsageRow, ModelBreakdownRow } from './api.ts';

export const DASHBOARD_WEEKDAYS = [
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
  '周日',
] as const;

export const DASHBOARD_HOURS = Array.from({ length: 24 }, (_, hour) =>
  String(hour).padStart(2, '0'),
);

/** Recent calendar dates ending today (UTC), used by the 7-day sample week. */
function buildRecentSampleDates(count: number): string[] {
  const end = new Date();
  const endUtc = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
  );
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(endUtc);
    date.setUTCDate(endUtc.getUTCDate() - (count - 1 - index));
    return date.toISOString().slice(0, 10);
  });
}

function formatSampleDateLabel(isoDate: string): string {
  const [, month = '', day = ''] = isoDate.split('-');
  return `${Number(month)}/${Number(day)}`;
}

const DISTRIBUTION_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const;

/**
 * Compact deterministic profiles for the offline mock-data preview
 * (`VITE_ENABLE_MOCK_DATA=true`). The browser bundle owns only presentation
 * samples; the API remains the source of truth whenever it is available.
 */
const SAMPLE_PROFILES = [
  {
    source: 'claude-code',
    model: 'claude-fable-5',
    terminal: 'VS Code',
    project: 'ai-usage',
    weight: 26,
    scale: 1.35,
  },
  {
    source: 'claude-code',
    model: 'MiniMax-M3',
    terminal: '系统终端',
    project: 'ai-usage',
    weight: 18,
    scale: 1.7,
  },
  {
    source: 'claude-code',
    model: 'claude-sonnet-4-6',
    terminal: 'VS Code',
    project: 'dashboard',
    weight: 12,
    scale: 1,
  },
  {
    source: 'codex',
    model: 'gpt-5',
    terminal: '系统终端',
    project: 'api-service',
    weight: 18,
    scale: 1.2,
  },
  {
    source: 'codex',
    model: 'gpt-5-mini',
    terminal: 'VS Code',
    project: 'docs-site',
    weight: 10,
    scale: 0.72,
  },
  {
    source: 'cursor',
    model: 'claude-sonnet-4-6',
    terminal: 'Cursor',
    project: 'design-system',
    weight: 10,
    scale: 0.88,
  },
  {
    source: 'cursor',
    model: 'gemini-2-5-pro',
    terminal: 'Cursor',
    project: 'marketing-site',
    weight: 6,
    scale: 1.08,
  },
] as const;

export type DashboardChartMetric = 'tokens' | 'cost' | 'duration';
export type DashboardDistributionMetric = Exclude<
  DashboardChartMetric,
  'duration'
>;

export interface DashboardHourlyUsageRow {
  day: (typeof DASHBOARD_WEEKDAYS)[number];
  hour: number;
  hourLabel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMinutes: number;
}

export interface DashboardDailyUsageRow {
  day: (typeof DASHBOARD_WEEKDAYS)[number];
  date: string;
  dateLabel: string;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMinutes: number;
}

export interface DashboardUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalDurationMinutes: number;
}

export interface DashboardMetricChanges {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface DashboardDistributionRow {
  id: string;
  label: string;
  color: string;
  tokens: number;
  costUsd: number;
  durationMinutes: number;
}

export interface DashboardDistributions {
  terminals: DashboardDistributionRow[];
  tools: DashboardDistributionRow[];
  models: DashboardDistributionRow[];
  projects: DashboardDistributionRow[];
}

export interface DashboardModelUsageRow {
  model: string;
  tokens: number;
  costUsd: number;
  /** Share of the parent tool's Token usage. */
  pct: number;
}

export interface DashboardProjectModelUsageRow {
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
  /** Share of the parent project's Token usage. */
  pct: number;
}

export interface DashboardToolUsageRow {
  source: string;
  tokens: number;
  costUsd: number;
  /** Share of the Dashboard's total Token usage. */
  pct: number;
  models: DashboardModelUsageRow[];
}

export interface DashboardProjectUsageRow {
  project: string;
  label: string;
  tokens: number;
  costUsd: number;
  /** Share of the Dashboard's total Token usage. */
  pct: number;
  models: DashboardProjectModelUsageRow[];
}

export interface DashboardToolUsageInput {
  source: string;
  tokens: number;
  costUsd: number;
  models: Array<{
    model: string;
    tokens: number;
    costUsd: number;
  }>;
}

/** Days of history for the GitHub-style activity heatmap (~52 weeks). */
export const HEATMAP_LOOKBACK_DAYS = 365;

export interface DashboardMockData {
  hourlyUsage: DashboardHourlyUsageRow[];
  /** Selected range daily rows (multi-day token curve). */
  rangeDailyUsage: DashboardDailyUsageRow[];
  /** Longer daily history for ActivityHeatmap (up to HEATMAP_LOOKBACK_DAYS). */
  heatmapDailyUsage: DashboardDailyUsageRow[];
  /**
   * API-shaped daily rows for ActivityHeatmap (keeps per-day `models`
   * so hover can show Agent / model breakdown).
   */
  heatmapDays: DailyUsageRow[];
  /** Model totals for mapping model → Agent source in heatmap tooltips. */
  modelRows: ModelBreakdownRow[];
  /**
   * Raw API hourly rows (Asia/Shanghai date+hour) for date-scoped projection.
   * Sparse — only hours with usage.
   */
  hourlyApiRows: HourlyUsageRow[];
  /** Last day split into hour buckets (today token curve). */
  todayHourlyUsage: DashboardHourlyUsageRow[];
  /** Always recent 7 days for DailyUsageTrendCard. */
  dailyUsage: DashboardDailyUsageRow[];
  summary: DashboardUsageSummary;
  changes: DashboardMetricChanges;
  distributions: DashboardDistributions;
  toolModelUsage: DashboardToolUsageRow[];
  projectModelUsage: DashboardProjectUsageRow[];
}

interface DashboardUsageSample extends DashboardHourlyUsageRow {
  source: string;
  model: string;
  terminal: string;
  project: string;
}

const usageSamples = buildUsageSamples();

export const dashboardMockData: DashboardMockData =
  buildDashboardMockData(usageSamples);

/** Zeroed dashboard model for loading / API-empty states when mock is off. */
export const emptyDashboardData: DashboardMockData = {
  hourlyUsage: [],
  rangeDailyUsage: [],
  heatmapDailyUsage: [],
  heatmapDays: [],
  modelRows: [],
  hourlyApiRows: [],
  todayHourlyUsage: [],
  dailyUsage: [],
  summary: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    totalDurationMinutes: 0,
  },
  changes: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  },
  distributions: {
    terminals: [],
    tools: [],
    models: [],
    projects: [],
  },
  toolModelUsage: [],
  projectModelUsage: [],
};

function buildUsageSamples(): DashboardUsageSample[] {
  return DASHBOARD_WEEKDAYS.flatMap((day, dayIndex) =>
    DASHBOARD_HOURS.map((hourLabel, hour) => {
      const profile = pickProfile(dayIndex, hour);
      const isWeekend = dayIndex >= 5;
      const morningPeak = Math.max(0, 1 - Math.abs(hour - 10) / 5);
      const eveningPeak = Math.max(0, 1 - Math.abs(hour - 20) / 5);
      const wave =
        (Math.sin((dayIndex + 1) * (hour + 3) * 0.77) + 1) / 2;
      const dayWeight = isWeekend ? 0.62 : 1;
      const intensity = Math.min(
        1,
        0.03 +
          dayWeight * (morningPeak * 0.4 + eveningPeak * 0.57) +
          wave * 0.14,
      );
      const totalTokens = Math.round(
        (500 + intensity * 38_000) * profile.scale,
      );
      const inputRatio = 0.72 + wave * 0.12;
      const inputTokens = Math.round(totalTokens * inputRatio);
      const outputTokens = totalTokens - inputTokens;
      const cachedInputRatio =
        profile.model.includes('MiniMax') ||
        profile.model.includes('fable')
          ? 0.42 + wave * 0.28
          : 0.08 + wave * 0.18;
      const cachedInputTokens = Math.min(
        inputTokens,
        Math.round(inputTokens * cachedInputRatio),
      );
      const costUsd = roundCurrency(
        inputTokens * 0.000004 + outputTokens * 0.000016,
      );

      return {
        day,
        hour,
        hourLabel,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        costUsd,
        durationMinutes: Math.round(3 + intensity * 72),
        source: profile.source,
        model: profile.model,
        terminal: profile.terminal,
        project: profile.project,
      };
    }),
  );
}

function buildDashboardMockData(
  samples: DashboardUsageSample[],
): DashboardMockData {
  const summary = aggregateUsage(samples);
  const dailyUsage = aggregateDailyUsage(samples);

  const hourlyUsage = samples.map((row) => ({
    day: row.day,
    hour: row.hour,
    hourLabel: row.hourLabel,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    durationMinutes: row.durationMinutes,
  }));
  const lastDay = dailyUsage.at(-1)?.day;
  const todayHourlyUsage = lastDay
    ? hourlyUsage.filter((row) => row.day === lastDay)
    : [];
  const heatmapDailyUsage = buildHeatmapSampleUsage(dailyUsage);
  const heatmapDays = toHeatmapDaysFromDashboard(heatmapDailyUsage);
  const modelRows = buildSampleModelRows(samples, summary.totalTokens);

  return {
    hourlyUsage,
    rangeDailyUsage: dailyUsage,
    heatmapDailyUsage,
    heatmapDays,
    modelRows,
    hourlyApiRows: [],
    todayHourlyUsage,
    dailyUsage,
    summary,
    changes: buildMetricChanges(dailyUsage),
    distributions: {
      terminals: aggregateDistribution(samples, (row) => row.terminal),
      tools: aggregateDistribution(samples, (row) => row.source),
      models: aggregateDistribution(samples, (row) => row.model),
      projects: aggregateDistribution(samples, (row) => row.project),
    },
    toolModelUsage: buildToolModelUsage(
      samples.map((row) => ({
        source: row.source,
        tokens: row.totalTokens,
        costUsd: row.costUsd,
        models: [
          {
            model: row.model,
            tokens: row.totalTokens,
            costUsd: row.costUsd,
          },
        ],
      })),
      summary.totalTokens,
    ),
    projectModelUsage: buildProjectModelUsage(
      Object.values(
        samples.reduce<
          Record<
            string,
            {
              project: string;
              tokens: number;
              costUsd: number;
              models: Array<{
                model: string;
                source: string;
                tokens: number;
                costUsd: number;
              }>;
            }
          >
        >((acc, row) => {
          const entry = acc[row.project] ?? {
            project: row.project,
            tokens: 0,
            costUsd: 0,
            models: [],
          };
          entry.tokens += row.totalTokens;
          entry.costUsd += row.costUsd;
          entry.models.push({
            model: row.model,
            source: row.source,
            tokens: row.totalTokens,
            costUsd: row.costUsd,
          });
          acc[row.project] = entry;
          return acc;
        }, {}),
      ),
      summary.totalTokens,
    ),
  };
}

/**
 * Build the two-level tool → model view shared by samples and API data.
 *
 * Tool percentages use the Dashboard total as the denominator; model
 * percentages deliberately use their parent tool so the two percentages
 * cannot be confused in the UI.
 */
export function buildToolModelUsage(
  rows: DashboardToolUsageInput[],
  totalTokens?: number,
): DashboardToolUsageRow[] {
  const tools = new Map<
    string,
    {
      tokens: number;
      costUsd: number;
      models: Map<string, { tokens: number; costUsd: number }>;
    }
  >();

  for (const row of rows) {
    if (!row.source || row.tokens <= 0) continue;

    const tool = tools.get(row.source) ?? {
      tokens: 0,
      costUsd: 0,
      models: new Map(),
    };
    tool.tokens += row.tokens;
    tool.costUsd += row.costUsd;

    for (const model of row.models) {
      if (!model.model || model.tokens <= 0) continue;
      const current = tool.models.get(model.model) ?? {
        tokens: 0,
        costUsd: 0,
      };
      current.tokens += model.tokens;
      current.costUsd += model.costUsd;
      tool.models.set(model.model, current);
    }

    tools.set(row.source, tool);
  }

  const aggregated = [...tools.entries()].sort(
    ([, a], [, b]) => b.tokens - a.tokens,
  );
  const toolTokenTotal =
    totalTokens && totalTokens > 0
      ? totalTokens
      : aggregated.reduce((sum, [, tool]) => sum + tool.tokens, 0);

  return aggregated.map(([source, tool]) => ({
    source,
    tokens: tool.tokens,
    costUsd: roundCurrency(tool.costUsd),
    pct: percentage(tool.tokens, toolTokenTotal),
    models: [...tool.models.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .map(([model, values]) => ({
        model,
        tokens: values.tokens,
        costUsd: roundCurrency(values.costUsd),
        pct: percentage(values.tokens, tool.tokens),
      })),
  }));
}

export function buildProjectModelUsage(
  rows: Array<{
    project: string;
    tokens: number;
    costUsd: number;
    pct?: number;
    models?: Array<{
      model: string;
      source: string;
      tokens: number;
      costUsd: number;
      pct?: number;
    }>;
  }>,
  totalTokens = 0,
): DashboardProjectUsageRow[] {
  const byProject = new Map<
    string,
    {
      project: string;
      tokens: number;
      costUsd: number;
      models: Map<
        string,
        { model: string; source: string; tokens: number; costUsd: number }
      >;
    }
  >();

  for (const row of rows) {
    if (row.tokens <= 0) continue;
    const project = normalizeProjectName(row.project);
    const current = byProject.get(project) ?? {
      project,
      tokens: 0,
      costUsd: 0,
      models: new Map(),
    };
    current.tokens += row.tokens;
    current.costUsd += row.costUsd;
    for (const model of row.models ?? []) {
      if (model.tokens <= 0) continue;
      const pairKey = `${model.source}\0${model.model}`;
      const existing = current.models.get(pairKey) ?? {
        model: model.model,
        source: model.source,
        tokens: 0,
        costUsd: 0,
      };
      existing.tokens += model.tokens;
      existing.costUsd += model.costUsd;
      current.models.set(pairKey, existing);
    }
    byProject.set(project, current);
  }

  const merged = Array.from(byProject.values());
  const tokenTotal =
    totalTokens > 0
      ? totalTokens
      : merged.reduce((sum, row) => sum + row.tokens, 0);

  return merged
    .map((row) => ({
      project: row.project,
      label: row.project === 'unknown' ? '未知项目' : row.project,
      tokens: row.tokens,
      costUsd: roundCurrency(row.costUsd),
      pct: percentage(row.tokens, tokenTotal),
      models: [...row.models.values()]
        .map((model) => ({
          model: model.model,
          source: model.source,
          tokens: model.tokens,
          costUsd: roundCurrency(model.costUsd),
          pct: percentage(model.tokens, row.tokens),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function pickProfile(dayIndex: number, hour: number) {
  const totalWeight = SAMPLE_PROFILES.reduce(
    (total, profile) => total + profile.weight,
    0,
  );
  let cursor = (dayIndex * 31 + hour * 17) % totalWeight;

  for (const profile of SAMPLE_PROFILES) {
    cursor -= profile.weight;
    if (cursor < 0) return profile;
  }

  return SAMPLE_PROFILES[0];
}

export function aggregateUsage(
  rows: DashboardHourlyUsageRow[],
): DashboardUsageSummary {
  const totals = rows.reduce<DashboardUsageSummary>(
    (current, row) => ({
      inputTokens: current.inputTokens + row.inputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      totalTokens: current.totalTokens + row.totalTokens,
      totalCostUsd: current.totalCostUsd + row.costUsd,
      totalDurationMinutes:
        current.totalDurationMinutes + row.durationMinutes,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      totalDurationMinutes: 0,
    },
  );

  return {
    ...totals,
    totalCostUsd: roundCurrency(totals.totalCostUsd),
  };
}

function aggregateDailyUsage(
  rows: DashboardHourlyUsageRow[],
): DashboardDailyUsageRow[] {
  const sampleDates = buildRecentSampleDates(DASHBOARD_WEEKDAYS.length);

  return sampleDates.map((date) => {
    const day = weekdayLabelForDate(date);
    const dayRows = rows.filter((row) => row.day === day);
    const usage = aggregateUsage(dayRows);
    const cachedInputTokens = dayRows.reduce(
      (total, row) => total + row.cachedInputTokens,
      0,
    );

    return {
      day,
      date,
      dateLabel: formatSampleDateLabel(date),
      ...usage,
      cachedInputTokens,
      uncachedInputTokens: usage.inputTokens - cachedInputTokens,
      costUsd: usage.totalCostUsd,
      durationMinutes: usage.totalDurationMinutes,
    };
  });
}

/** Expand the 7-day sample week across ~1 year ending today for the heatmap. */
function buildHeatmapSampleUsage(
  weekRows: DashboardDailyUsageRow[],
): DashboardDailyUsageRow[] {
  if (weekRows.length === 0) return [];

  const dates = buildRecentSampleDates(HEATMAP_LOOKBACK_DAYS);
  return dates.map((date, index) => {
    const template = weekRows[index % weekRows.length];
    const wave = (Math.sin(index * 0.37) + 1) / 2;
    const scale = 0.35 + wave * 0.9;
    // Sparse quieter days so the grid looks like a real contribution chart.
    const active = (index * 17 + 11) % 5 !== 0;
    const factor = active ? scale : 0;

    return {
      ...template,
      day: weekdayLabelForDate(date),
      date,
      dateLabel: formatSampleDateLabel(date),
      inputTokens: Math.round(template.inputTokens * factor),
      cachedInputTokens: Math.round(template.cachedInputTokens * factor),
      uncachedInputTokens: Math.round(template.uncachedInputTokens * factor),
      outputTokens: Math.round(template.outputTokens * factor),
      totalTokens: Math.round(template.totalTokens * factor),
      costUsd: roundCurrency(template.costUsd * factor),
      durationMinutes: Math.round(template.durationMinutes * factor),
    };
  });
}

export function toHeatmapDaysFromDashboard(
  rows: DashboardDailyUsageRow[],
): DailyUsageRow[] {
  return rows.map((row) => ({
    date: row.date,
    tokens: row.totalTokens,
    costUsd: row.costUsd,
    models: {},
  }));
}

function buildSampleModelRows(
  samples: DashboardUsageSample[],
  totalTokens: number,
): ModelBreakdownRow[] {
  const byKey = new Map<
    string,
    { model: string; source: string; tokens: number; costUsd: number }
  >();

  for (const row of samples) {
    const key = `${row.source}:${row.model}`;
    const current = byKey.get(key) ?? {
      model: row.model,
      source: row.source,
      tokens: 0,
      costUsd: 0,
    };
    current.tokens += row.totalTokens;
    current.costUsd += row.costUsd;
    byKey.set(key, current);
  }

  const denom = Math.max(1, totalTokens);
  return [...byKey.values()]
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((row) => ({
      ...row,
      pct: (row.tokens / denom) * 100,
    }));
}

function weekdayLabelForDate(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const mondayIndex = (date.getUTCDay() + 6) % 7;
  return DASHBOARD_WEEKDAYS[mondayIndex];
}

export function buildMetricChanges(
  rows: DashboardDailyUsageRow[],
): DashboardMetricChanges {
  if (rows.length < 2) {
    return {
      totalCostUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const splitIndex = Math.floor(rows.length / 2);
  const previous = aggregateDailyAverage(rows.slice(0, splitIndex));
  const current = aggregateDailyAverage(rows.slice(splitIndex));

  return {
    totalCostUsd: percentChange(
      current.totalCostUsd,
      previous.totalCostUsd,
    ),
    totalTokens: percentChange(current.totalTokens, previous.totalTokens),
    inputTokens: percentChange(current.inputTokens, previous.inputTokens),
    outputTokens: percentChange(
      current.outputTokens,
      previous.outputTokens,
    ),
  };
}

function aggregateDailyAverage(
  rows: DashboardDailyUsageRow[],
): DashboardUsageSummary {
  const divisor = Math.max(1, rows.length);
  const totals = rows.reduce<DashboardUsageSummary>(
    (current, row) => ({
      inputTokens: current.inputTokens + row.inputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      totalTokens: current.totalTokens + row.totalTokens,
      totalCostUsd: current.totalCostUsd + row.costUsd,
      totalDurationMinutes:
        current.totalDurationMinutes + row.durationMinutes,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      totalDurationMinutes: 0,
    },
  );

  return {
    inputTokens: totals.inputTokens / divisor,
    outputTokens: totals.outputTokens / divisor,
    totalTokens: totals.totalTokens / divisor,
    totalCostUsd: totals.totalCostUsd / divisor,
    totalDurationMinutes: totals.totalDurationMinutes / divisor,
  };
}

function aggregateDistribution(
  rows: DashboardUsageSample[],
  getKey: (row: DashboardUsageSample) => string,
): DashboardDistributionRow[] {
  const groups = new Map<
    string,
    Pick<
      DashboardDistributionRow,
      'tokens' | 'costUsd' | 'durationMinutes'
    >
  >();

  for (const row of rows) {
    const key = getKey(row);
    const current = groups.get(key) ?? {
      tokens: 0,
      costUsd: 0,
      durationMinutes: 0,
    };
    current.tokens += row.totalTokens;
    current.costUsd += row.costUsd;
    current.durationMinutes += row.durationMinutes;
    groups.set(key, current);
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => b.tokens - a.tokens)
    .map(([label, values], index) => ({
      id: slugify(label),
      label,
      color: DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length],
      tokens: values.tokens,
      costUsd: roundCurrency(values.costUsd),
      durationMinutes: values.durationMinutes,
    }));
}

function percentChange(current: number, previous: number) {
  if (previous <= 0) return 0;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function percentage(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1_000) / 10;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

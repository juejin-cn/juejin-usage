import { normalizeProjectName } from '@juejin-opensource/jusage-core/project-label';
import type { DailyUsageRow, HourlyUsageRow, ModelBreakdownRow } from './api.ts';

/** Presentation model shared by server-backed dashboard components. */
export const DASHBOARD_WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;
export const DASHBOARD_HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
export const HEATMAP_LOOKBACK_DAYS = 365;

export type DashboardChartMetric = 'tokens' | 'cost' | 'duration';
export type DashboardDistributionMetric = Exclude<DashboardChartMetric, 'duration'>;

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

export interface DashboardMetricTrend {
  changePct: number;
  changeValue: number;
}

export interface DashboardMetricTrends {
  inputTokens: DashboardMetricTrend | null;
  outputTokens: DashboardMetricTrend | null;
  totalTokens: DashboardMetricTrend | null;
  totalCostUsd: DashboardMetricTrend | null;
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
  pct: number;
}

export interface DashboardProjectModelUsageRow {
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
}

export interface DashboardToolUsageRow {
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
  models: DashboardModelUsageRow[];
}

export interface DashboardProjectUsageRow {
  project: string;
  label: string;
  tokens: number;
  costUsd: number;
  pct: number;
  models: DashboardProjectModelUsageRow[];
}

export interface DashboardToolUsageInput {
  source: string;
  tokens: number;
  costUsd: number;
  models: Array<{ model: string; tokens: number; costUsd: number }>;
}

export interface DashboardMockData {
  hourlyUsage: DashboardHourlyUsageRow[];
  rangeDailyUsage: DashboardDailyUsageRow[];
  heatmapDailyUsage: DashboardDailyUsageRow[];
  heatmapDays: DailyUsageRow[];
  modelRows: ModelBreakdownRow[];
  /** Sparse API hourly rows (Asia/Shanghai) for date-scoped projection. */
  hourlyApiRows: HourlyUsageRow[];
  todayHourlyUsage: DashboardHourlyUsageRow[];
  dailyUsage: DashboardDailyUsageRow[];
  summary: DashboardUsageSummary;
  changes: DashboardMetricChanges;
  /** Hidden when either comparison period has no usage data. */
  metricTrends: DashboardMetricTrends;
  distributions: DashboardDistributions;
  toolModelUsage: DashboardToolUsageRow[];
  projectModelUsage: DashboardProjectUsageRow[];
}

/** Empty state used while server data is loading or unavailable. */
export const emptyDashboardData: DashboardMockData = {
  hourlyUsage: [],
  rangeDailyUsage: [],
  heatmapDailyUsage: [],
  heatmapDays: [],
  modelRows: [],
  hourlyApiRows: [],
  todayHourlyUsage: [],
  dailyUsage: [],
  summary: { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0, totalDurationMinutes: 0 },
  changes: { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0 },
  metricTrends: {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    totalCostUsd: null,
  },
  distributions: { terminals: [], tools: [], models: [], projects: [] },
  toolModelUsage: [],
  projectModelUsage: [],
};

export function buildToolModelUsage(rows: DashboardToolUsageInput[], totalTokens = 0): DashboardToolUsageRow[] {
  const tools = new Map<string, { tokens: number; costUsd: number; models: Map<string, { tokens: number; costUsd: number }> }>();
  for (const row of rows) {
    if (!row.source || row.tokens <= 0) continue;
    const tool = tools.get(row.source) ?? { tokens: 0, costUsd: 0, models: new Map() };
    tool.tokens += row.tokens;
    tool.costUsd += row.costUsd;
    for (const model of row.models) {
      const current = tool.models.get(model.model) ?? { tokens: 0, costUsd: 0 };
      current.tokens += model.tokens;
      current.costUsd += model.costUsd;
      tool.models.set(model.model, current);
    }
    tools.set(row.source, tool);
  }
  return [...tools.entries()].map(([source, tool]) => ({
    source, tokens: tool.tokens, costUsd: Math.round(tool.costUsd * 100) / 100, pct: totalTokens > 0 ? (tool.tokens / totalTokens) * 100 : 0,
    models: [...tool.models.entries()].map(([model, usage]) => ({ model, tokens: usage.tokens, costUsd: Math.round(usage.costUsd * 100) / 100, pct: tool.tokens > 0 ? (usage.tokens / tool.tokens) * 100 : 0 })),
  })).sort((a, b) => b.tokens - a.tokens);
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
      costUsd: Math.round(row.costUsd * 100) / 100,
      pct: tokenTotal > 0 ? (row.tokens / tokenTotal) * 100 : 0,
      models: [...row.models.values()]
        .map((model) => ({
          model: model.model,
          source: model.source,
          tokens: model.tokens,
          costUsd: Math.round(model.costUsd * 100) / 100,
          pct: row.tokens > 0 ? (model.tokens / row.tokens) * 100 : 0,
        }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

export function aggregateUsage(rows: Array<Pick<DashboardHourlyUsageRow, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd' | 'durationMinutes'>>): DashboardUsageSummary {
  return rows.reduce<DashboardUsageSummary>((total, row) => ({
    inputTokens: total.inputTokens + row.inputTokens, outputTokens: total.outputTokens + row.outputTokens,
    totalTokens: total.totalTokens + row.totalTokens, totalCostUsd: total.totalCostUsd + row.costUsd,
    totalDurationMinutes: total.totalDurationMinutes + row.durationMinutes,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0, totalDurationMinutes: 0 });
}

export function toHeatmapDaysFromDashboard(rows: DashboardDailyUsageRow[]): DailyUsageRow[] {
  return rows.map((row) => ({ date: row.date, tokens: row.totalTokens, costUsd: row.costUsd, models: {} }));
}

export function buildMetricChanges(rows: DashboardDailyUsageRow[]): DashboardMetricChanges {
  const current = rows.at(-1);
  const previous = rows.at(-2);
  if (!current || !previous) return { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0 };
  const change = (value: number, before: number) => before > 0 ? ((value - before) / before) * 100 : 0;
  return {
    inputTokens: change(current.inputTokens, previous.inputTokens),
    outputTokens: change(current.outputTokens, previous.outputTokens),
    totalTokens: change(current.totalTokens, previous.totalTokens),
    totalCostUsd: change(current.costUsd, previous.costUsd),
  };
}

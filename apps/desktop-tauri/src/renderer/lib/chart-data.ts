/**
 * Data transformers that turn raw API rows into the shape used by the
 * dashboard's Recharts primitives.
 *
 * - Each builder returns `{ config, rows }`. `config` is the
 *   `ChartConfig` (label + color per series key), `rows` is the data
 *   array fed into a recharts chart.
 * - All builders are pure functions: the same input always produces
 *   structurally identical output, so wrapping them in `useMemo`
 *   keeps reference identity stable across 5s polling ticks.
 * - Empty inputs return `{ rows: [], config: {} }` so callers can
 *   render an empty state without an explicit `length === 0` branch.
 *
 * Color strategy:
 * - `var(--chart-N)` cycled 1..8: primary blue + BoardUI pastel accents.
 * - Stacked + ranking share the same model→color map so a model
 *   keeps one color across both charts.
 */

import { parseDailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import type {
  DailyUsageRow,
  ModelBreakdownRow,
} from './api';
import type { ChartConfig } from '@/components/ChartPrimitives';
import type {
  DashboardProjectUsageRow,
  DashboardToolUsageRow,
} from './dashboard-mock-data';

const CHART_VAR_PREFIX = 'var(--chart-';
const CHART_COLOR_COUNT = 8;

/** Cycle through `--chart-1`..`--chart-8` for arbitrary series index. */
export function chartColor(index: number): string {
  const n = (index % CHART_COLOR_COUNT) + 1;
  return `${CHART_VAR_PREFIX}${n})`;
}

/**
 * Shared model→color map: aggregate tokens by model name (across sources),
 * sort desc, assign chart colors. Used by stacked + ranking.
 */
export function buildModelColorMap(
  modelRows: ModelBreakdownRow[],
): Map<string, string> {
  const totals = new Map<string, number>();
  for (const row of modelRows) {
    if (row.tokens <= 0) continue;
    totals.set(row.model, (totals.get(row.model) ?? 0) + row.tokens);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const map = new Map<string, string>();
  sorted.forEach(([model], i) => {
    map.set(model, chartColor(i));
  });
  return map;
}

/**
 * model → primary source (highest tokens when the same name appears
 * under multiple agents). Used for stacked-chart tooltips / icons.
 */
export function buildModelSourceMap(
  modelRows: ModelBreakdownRow[],
): Map<string, string> {
  const best = new Map<string, { source: string; tokens: number }>();
  for (const row of modelRows) {
    if (row.tokens <= 0) continue;
    const cur = best.get(row.model);
    if (!cur || row.tokens > cur.tokens) {
      best.set(row.model, { source: row.source, tokens: row.tokens });
    }
  }
  const map = new Map<string, string>();
  for (const [model, entry] of best) {
    map.set(model, entry.source);
  }
  return map;
}

export interface ChartData {
  config: ChartConfig;
  rows: Record<string, unknown>[];
  /** model name → agent source (stacked chart). */
  modelSources?: Record<string, string>;
}

export interface ToolModelChartSegment {
  key: string;
  model: string;
  tokens: number;
  costUsd: number;
  /** Share of the parent tool's Token usage. */
  pct: number;
  isUnattributed?: boolean;
}

export interface ToolModelChartSeries {
  key: string;
  model: string;
  color: string;
  tokens: number;
  isUnattributed?: boolean;
}

export interface ToolModelStackedChartRow {
  [key: string]: unknown;
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
  modelCount: number;
  segments: Record<string, ToolModelChartSegment>;
}

export interface ToolModelStackedChartData {
  config: ChartConfig;
  rows: ToolModelStackedChartRow[];
  series: ToolModelChartSeries[];
}

const UNATTRIBUTED_KEY = 'unattributed';
const UNATTRIBUTED_LABEL = '未归类';

/**
 * Build a horizontal tool ranking whose total bar length is the tool's Token
 * usage and whose stacked segments preserve the exact per-model Token values.
 *
 * Dynamic model names are deliberately mapped to safe keys (`model-N`) so
 * they can be used as Recharts data keys and ChartContainer CSS variables.
 */
export function buildToolModelStackedChart(
  toolRows: DashboardToolUsageRow[],
): ToolModelStackedChartData {
  const activeRows = toolRows
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  if (activeRows.length === 0) {
    return { config: {}, rows: [], series: [] };
  }

  const modelTotals = new Map<string, number>();
  const preparedRows = activeRows.map((row) => {
    const models = new Map<
      string,
      { tokens: number; costUsd: number; pct: number }
    >();

    for (const model of row.models) {
      if (!model.model || model.tokens <= 0) continue;

      const current = models.get(model.model) ?? {
        tokens: 0,
        costUsd: 0,
        pct: 0,
      };
      current.tokens += model.tokens;
      current.costUsd += model.costUsd;
      current.pct += model.pct;
      models.set(model.model, current);
      modelTotals.set(
        model.model,
        (modelTotals.get(model.model) ?? 0) + model.tokens,
      );
    }

    let attributedTokens = 0;
    let attributedCostUsd = 0;
    for (const model of models.values()) {
      attributedTokens += model.tokens;
      attributedCostUsd += model.costUsd;
    }

    return {
      row,
      models,
      unattributedTokens: Math.max(0, row.tokens - attributedTokens),
      unattributedCostUsd: Math.max(0, row.costUsd - attributedCostUsd),
    };
  });

  const series: ToolModelChartSeries[] = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, tokens], index) => ({
      key: `model-${index}`,
      model,
      color: chartColor(index),
      tokens,
    }));

  const unattributedTokens = preparedRows.reduce(
    (sum, row) => sum + row.unattributedTokens,
    0,
  );
  if (unattributedTokens > 0) {
    series.push({
      key: UNATTRIBUTED_KEY,
      model: UNATTRIBUTED_LABEL,
      color: 'var(--muted)',
      tokens: unattributedTokens,
      isUnattributed: true,
    });
  }

  const seriesByModel = new Map(
    series
      .filter((item) => !item.isUnattributed)
      .map((item) => [item.model, item]),
  );
  const config: ChartConfig = Object.fromEntries(
    series.map((item) => [
      item.key,
      { label: item.model, color: item.color },
    ]),
  );

  const rows = preparedRows.map(
    ({ row, models, unattributedTokens: missingTokens, unattributedCostUsd }) => {
      const chartRow: ToolModelStackedChartRow = {
        source: row.source,
        tokens: row.tokens,
        costUsd: row.costUsd,
        pct: row.pct,
        modelCount: row.models.length,
        segments: {},
      };

      for (const item of series) {
        chartRow[item.key] = 0;
      }

      for (const [model, values] of models) {
        const item = seriesByModel.get(model);
        if (!item) continue;

        chartRow[item.key] = values.tokens;
        chartRow.segments[item.key] = {
          key: item.key,
          model,
          tokens: values.tokens,
          costUsd: values.costUsd,
          pct: values.pct,
        };
      }

      if (missingTokens > 0) {
        chartRow[UNATTRIBUTED_KEY] = missingTokens;
        chartRow.segments[UNATTRIBUTED_KEY] = {
          key: UNATTRIBUTED_KEY,
          model: UNATTRIBUTED_LABEL,
          tokens: missingTokens,
          costUsd: unattributedCostUsd,
          pct: row.tokens > 0 ? (missingTokens / row.tokens) * 100 : 0,
          isUnattributed: true,
        };
      }

      return chartRow;
    },
  );

  return { config, rows, series };
}

export interface ProjectModelChartSegment {
  key: string;
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
  isUnattributed?: boolean;
}

export interface ProjectModelChartSeries {
  key: string;
  model: string;
  source: string;
  color: string;
  tokens: number;
  isUnattributed?: boolean;
}

export interface ProjectModelStackedChartRow {
  [key: string]: unknown;
  project: string;
  label: string;
  tokens: number;
  costUsd: number;
  pct: number;
  modelCount: number;
  segments: Record<string, ProjectModelChartSegment>;
}

export interface ProjectModelStackedChartData {
  config: ChartConfig;
  rows: ProjectModelStackedChartRow[];
  series: ProjectModelChartSeries[];
}

/** Project ranking with stacked segments keyed by source+model. */
export function buildProjectModelStackedChart(
  projectRows: DashboardProjectUsageRow[],
): ProjectModelStackedChartData {
  const activeRows = projectRows
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  if (activeRows.length === 0) {
    return { config: {}, rows: [], series: [] };
  }

  const pairTotals = new Map<
    string,
    { source: string; model: string; tokens: number }
  >();
  const preparedRows = activeRows.map((row) => {
    const models = new Map<
      string,
      {
        source: string;
        model: string;
        tokens: number;
        costUsd: number;
        pct: number;
      }
    >();

    for (const model of row.models) {
      if (!model.model || !model.source || model.tokens <= 0) continue;
      const pairKey = `${model.source}\0${model.model}`;
      const current = models.get(pairKey) ?? {
        source: model.source,
        model: model.model,
        tokens: 0,
        costUsd: 0,
        pct: 0,
      };
      current.tokens += model.tokens;
      current.costUsd += model.costUsd;
      current.pct += model.pct;
      models.set(pairKey, current);

      const total = pairTotals.get(pairKey) ?? {
        source: model.source,
        model: model.model,
        tokens: 0,
      };
      total.tokens += model.tokens;
      pairTotals.set(pairKey, total);
    }

    let attributedTokens = 0;
    let attributedCostUsd = 0;
    for (const model of models.values()) {
      attributedTokens += model.tokens;
      attributedCostUsd += model.costUsd;
    }

    return {
      row,
      models,
      unattributedTokens: Math.max(0, row.tokens - attributedTokens),
      unattributedCostUsd: Math.max(0, row.costUsd - attributedCostUsd),
    };
  });

  const seriesMeta = [...pairTotals.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([pairKey, value], index) => ({
      key: `seg-${index}`,
      pairKey,
      model: value.model,
      source: value.source,
      color: chartColor(index),
      tokens: value.tokens,
    }));

  const unattributedTokens = preparedRows.reduce(
    (sum, row) => sum + row.unattributedTokens,
    0,
  );
  if (unattributedTokens > 0) {
    seriesMeta.push({
      key: UNATTRIBUTED_KEY,
      pairKey: UNATTRIBUTED_KEY,
      model: UNATTRIBUTED_LABEL,
      source: '',
      color: 'var(--muted)',
      tokens: unattributedTokens,
    });
  }

  const seriesByPair = new Map(
    seriesMeta
      .filter((item) => item.key !== UNATTRIBUTED_KEY)
      .map((item) => [item.pairKey, item]),
  );

  const series: ProjectModelChartSeries[] = seriesMeta.map((item) => ({
    key: item.key,
    model: item.model,
    source: item.source,
    color: item.color,
    tokens: item.tokens,
    ...(item.key === UNATTRIBUTED_KEY ? { isUnattributed: true as const } : {}),
  }));

  const config: ChartConfig = Object.fromEntries(
    series.map((item) => [
      item.key,
      {
        label: item.source ? `${item.source}:${item.model}` : item.model,
        color: item.color,
      },
    ]),
  );

  const rows = preparedRows.map(
    ({ row, models, unattributedTokens: missingTokens, unattributedCostUsd }) => {
      const chartRow: ProjectModelStackedChartRow = {
        project: row.project,
        label: row.label,
        tokens: row.tokens,
        costUsd: row.costUsd,
        pct: row.pct,
        modelCount: row.models.length,
        segments: {},
      };

      for (const item of series) {
        chartRow[item.key] = 0;
      }

      for (const [pairKey, values] of models) {
        const item = seriesByPair.get(pairKey);
        if (!item) continue;

        chartRow[item.key] = values.tokens;
        chartRow.segments[item.key] = {
          key: item.key,
          model: values.model,
          source: values.source,
          tokens: values.tokens,
          costUsd: values.costUsd,
          pct: values.pct,
        };
      }

      if (missingTokens > 0) {
        chartRow[UNATTRIBUTED_KEY] = missingTokens;
        chartRow.segments[UNATTRIBUTED_KEY] = {
          key: UNATTRIBUTED_KEY,
          model: UNATTRIBUTED_LABEL,
          source: '',
          tokens: missingTokens,
          costUsd: unattributedCostUsd,
          pct: row.tokens > 0 ? (missingTokens / row.tokens) * 100 : 0,
          isUnattributed: true,
        };
      }

      return chartRow;
    },
  );

  return { config, rows, series };
}

/** C1 — 每日 Token 用量趋势（单层 AreaChart）。 */
export function buildTokenTrend(dailyRows: DailyUsageRow[]): ChartData {
  if (dailyRows.length === 0) {
    return { config: {}, rows: [] };
  }
  const config: ChartConfig = {
    tokens: {
      label: 'Token',
      color: 'var(--chart-1)',
    },
  };
  const rows = dailyRows.map((d) => ({
    date: d.date,
    tokens: d.tokens,
    costUsd: d.costUsd,
  }));
  return { config, rows };
}

/** C3 — 模型使用排行（水平 BarChart，按 tokens 倒序，Top N）。 */
export function buildModelRanking(
  modelRows: ModelBreakdownRow[],
  topN = 8,
  colorMap?: Map<string, string>,
): ChartData {
  const active = modelRows.filter((row) => row.tokens > 0);
  if (active.length === 0) {
    return { config: {}, rows: [] };
  }
  const colors = colorMap ?? buildModelColorMap(active);
  const sorted = [...active].sort((a, b) => b.tokens - a.tokens);
  const top = sorted.slice(0, topN);

  const config: ChartConfig = {};
  top.forEach((row) => {
    const key = `${row.source}:${row.model}`;
    config[key] = {
      label: row.model,
      color: colors.get(row.model) ?? chartColor(0),
    };
  });

  const rows = top.map((row) => {
    const key = `${row.source}:${row.model}`;
    return {
      model: row.model,
      source: row.source,
      tokens: row.tokens,
      costUsd: row.costUsd,
      pct: row.pct,
      _seriesKey: key,
      fill: colors.get(row.model) ?? chartColor(0),
    };
  });
  return { config, rows };
}

/** C4 — 每日多模型堆叠面积。
 *  Top K is chosen from `modelRows` (30-day aggregate) so the legend
 *  stays stable across the 180-day x-axis. Other models collapse into
 *  a single "其他" series so we never paint more than K+1 series.
 */
export function buildStackedByModel(
  dailyRows: DailyUsageRow[],
  modelRows: ModelBreakdownRow[],
  topK = 6,
  colorMap?: Map<string, string>,
): ChartData {
  const active = modelRows.filter((row) => row.tokens > 0);
  if (dailyRows.length === 0 || active.length === 0) {
    return { config: {}, rows: [], modelSources: {} };
  }

  const colors = colorMap ?? buildModelColorMap(active);
  const sources = buildModelSourceMap(active);

  // Pick top-K models by 30-day aggregate tokens (by model name).
  const totals = new Map<string, number>();
  for (const row of active) {
    totals.set(row.model, (totals.get(row.model) ?? 0) + row.tokens);
  }
  const topModels = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([model]) => model);
  const topSet = new Set(topModels);

  const config: ChartConfig = {};
  const modelSources: Record<string, string> = {};
  topModels.forEach((model) => {
    config[model] = {
      label: model,
      color: colors.get(model) ?? chartColor(0),
    };
    const source = sources.get(model);
    if (source) modelSources[model] = source;
  });

  let hasOverflow = false;
  for (const d of dailyRows) {
    for (const [key, tokens] of Object.entries(d.models)) {
      const model = parseDailyModelKey(key).model;
      if (tokens > 0 && !topSet.has(model)) {
        hasOverflow = true;
        break;
      }
    }
    if (hasOverflow) break;
  }
  if (hasOverflow) {
    config['其他'] = { label: '其他', color: 'var(--muted)' };
  }

  const rows = dailyRows.map((d) => {
    const row: Record<string, number | string> = { date: d.date };
    // Explicit 0 for every top model so sparse days stay continuous / visible.
    for (const model of topModels) {
      row[model] = 0;
    }
    let otherSum = 0;
    for (const [key, tokens] of Object.entries(d.models)) {
      if (tokens <= 0) continue;
      const model = parseDailyModelKey(key).model;
      if (topSet.has(model)) {
        row[model] = (Number(row[model]) || 0) + tokens;
      } else {
        otherSum += tokens;
      }
    }
    if (hasOverflow) {
      row['其他'] = otherSum;
    }
    return row;
  });

  return { config, rows, modelSources };
}

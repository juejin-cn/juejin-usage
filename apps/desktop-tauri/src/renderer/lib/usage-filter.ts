import { parseDailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import { chartColor } from './chart-data.ts';
import type { DailyUsageRow, HourlyUsageRow, ModelBreakdownRow } from './api.ts';
import { buildFilledHourlyForDate } from './dashboard-data.ts';
import type {
  DashboardDailyUsageRow,
  DashboardDistributionRow,
  DashboardHourlyUsageRow,
  DashboardProjectUsageRow,
  DashboardToolUsageRow,
} from './dashboard-mock-data.ts';
import { sourceLabel } from './tokens.ts';

/** Collect platform keys with usage, preferring tool-panel order. */
export function collectPlatformSources(
  toolRows: DashboardToolUsageRow[] = [],
  modelRows: ModelBreakdownRow[] = [],
): string[] {
  if (toolRows.length > 0) {
    return toolRows.filter((row) => row.tokens > 0).map((row) => row.source);
  }
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const row of modelRows) {
    if (row.tokens <= 0 || seen.has(row.source)) continue;
    seen.add(row.source);
    sources.push(row.source);
  }
  return sources;
}

export function buildModelSourceFallback(
  modelRows: ModelBreakdownRow[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of modelRows) {
    if (!map.has(row.model)) map.set(row.model, row.source);
  }
  return map;
}

export function resolveActiveKeys(
  allKeys: string[],
  selected: string[] | null,
): string[] {
  if (selected == null) return allKeys;
  const available = new Set(allKeys);
  return selected.filter((key) => available.has(key));
}

/** Align `claude` / `claude-code` (and similar aliases) when filtering. */
export function normalizeSourceId(source: string): string {
  const key = source?.toLowerCase?.() ?? '';
  if (key === 'claude-code' || key.startsWith('claude')) return 'claude';
  if (key === 'codex' || key.startsWith('codex')) return 'codex';
  if (key === 'cursor' || key.startsWith('cursor')) return 'cursor';
  if (key === 'qoder' || key.startsWith('qoder')) return 'qoder';
  if (key === 'trae' || key.startsWith('trae')) return 'trae';
  return key;
}

export function sourceInSet(source: string, set: Set<string>): boolean {
  if (set.has(source)) return true;
  const normalized = normalizeSourceId(source);
  for (const item of set) {
    if (normalizeSourceId(item) === normalized) return true;
  }
  return false;
}

export function filterShareForDay(
  dayModels: Record<string, number>,
  selectedSources: string[] | null,
  selectedModels: string[] | null,
  opts: {
    activeSources: string[];
    activeModels: string[];
    sourceFallback: Map<string, string>;
    fallbackShare: number;
  },
): number {
  if (selectedSources == null && selectedModels == null) return 1;
  if (selectedSources != null && opts.activeSources.length === 0) return 0;
  if (selectedModels != null && opts.activeModels.length === 0) return 0;

  const entries = Object.entries(dayModels).filter(([, tokens]) => tokens > 0);
  if (entries.length === 0) return opts.fallbackShare;

  const sourceSet =
    selectedSources == null ? null : new Set(opts.activeSources);
  const modelSet = selectedModels == null ? null : new Set(opts.activeModels);

  let total = 0;
  let matched = 0;
  for (const [key, tokens] of entries) {
    total += tokens;
    const parsed = parseDailyModelKey(key);
    const source =
      parsed.source ?? opts.sourceFallback.get(parsed.model) ?? 'unknown';
    const model = parsed.model;
    if (sourceSet && !sourceInSet(source, sourceSet)) continue;
    if (modelSet && !modelSet.has(model)) continue;
    matched += tokens;
  }

  return total > 0 ? matched / total : 0;
}

export function computeModelRowsShare(
  modelRows: ModelBreakdownRow[],
  selectedSources: string[] | null,
  selectedModels: string[] | null,
  opts: { activeSources: string[]; activeModels: string[] },
): number {
  if (selectedSources == null && selectedModels == null) return 1;
  if (modelRows.length === 0) return 1;
  if (selectedSources != null && opts.activeSources.length === 0) return 0;
  if (selectedModels != null && opts.activeModels.length === 0) return 0;

  const sourceSet =
    selectedSources == null ? null : new Set(opts.activeSources);
  const modelSet = selectedModels == null ? null : new Set(opts.activeModels);

  let total = 0;
  let matched = 0;
  for (const row of modelRows) {
    if (row.tokens <= 0) continue;
    total += row.tokens;
    if (sourceSet && !sourceInSet(row.source, sourceSet)) continue;
    if (modelSet && !modelSet.has(row.model)) continue;
    matched += row.tokens;
  }

  return total > 0 ? matched / total : 0;
}

/** Filter a day models map down to selected platforms (keeps original keys). */
export function filterDayModelsBySources(
  dayModels: Record<string, number>,
  selectedSources: string[] | null,
  opts: {
    activeSources: string[];
    sourceFallback: Map<string, string>;
  },
): Record<string, number> {
  if (selectedSources == null) return dayModels;
  if (opts.activeSources.length === 0) return {};

  const sourceSet = new Set(opts.activeSources);
  const next: Record<string, number> = {};
  for (const [key, tokens] of Object.entries(dayModels)) {
    if (tokens <= 0) continue;
    const parsed = parseDailyModelKey(key);
    const source =
      parsed.source ?? opts.sourceFallback.get(parsed.model) ?? 'unknown';
    if (!sourceInSet(source, sourceSet)) continue;
    next[key] = tokens;
  }
  return next;
}

/** Scale daily / hourly trend rows to selected tool channels via per-day model share. */
export function filterTrendRowsBySources(opts: {
  dailyRows: DashboardDailyUsageRow[];
  hourlyRows: DashboardHourlyUsageRow[];
  /** Sparse API hourly rows (may include multiple sources per hour). */
  hourlyApiRows: HourlyUsageRow[];
  /** Local date (Asia/Shanghai) the hourly chart is focused on. */
  hourlyDate?: string;
  heatmapDays: DailyUsageRow[];
  modelRows: ModelBreakdownRow[];
  toolRows: DashboardToolUsageRow[];
  /** Empty = all channels (no scaling). */
  selectedSources: string[];
}): {
  dailyRows: DashboardDailyUsageRow[];
  hourlyRows: DashboardHourlyUsageRow[];
} {
  if (opts.selectedSources.length === 0) {
    return { dailyRows: opts.dailyRows, hourlyRows: opts.hourlyRows };
  }

  const selectedSources = opts.selectedSources;
  const allSources = collectPlatformSources(opts.toolRows, opts.modelRows);
  const activeSources = resolveActiveKeys(allSources, selectedSources);
  const sourceFallback = buildModelSourceFallback(opts.modelRows);
  const rangeFilterShare = computeModelRowsShare(
    opts.modelRows,
    selectedSources,
    null,
    { activeSources, activeModels: [] },
  );
  const dayByDate = new Map(opts.heatmapDays.map((day) => [day.date, day]));

  const shareForDate = (date: string): number => {
    const day = dayByDate.get(date);
    if (!day) return rangeFilterShare;
    return filterShareForDay(day.models ?? {}, selectedSources, null, {
      activeSources,
      activeModels: [],
      sourceFallback,
      fallbackShare: rangeFilterShare,
    });
  };

  const dailyRows = opts.dailyRows.map((row) =>
    scaleDailyTrendRow(row, shareForDate(row.date)),
  );

  // Hourly: filter by source then re-bucket — do not scale all hours by day share.
  const hourlyDate = opts.hourlyDate;
  let hourlyRows = opts.hourlyRows;
  if (hourlyDate != null) {
    if (opts.hourlyApiRows.length === 0) {
      // Sample / legacy payloads without per-source hourly rows.
      hourlyRows = opts.hourlyRows.map((row) =>
        scaleHourlyTrendRow(row, shareForDate(hourlyDate)),
      );
    } else {
      const sourceSet = new Set(activeSources);
      const filteredApiRows =
        activeSources.length === 0
          ? []
          : opts.hourlyApiRows.filter((row) =>
              sourceInSet(row.source || 'unknown', sourceSet),
            );
      const upToHour =
        opts.hourlyRows.length > 0
          ? Math.max(...opts.hourlyRows.map((row) => row.hour))
          : undefined;
      hourlyRows = buildFilledHourlyForDate(
        filteredApiRows,
        hourlyDate,
        upToHour,
      );
    }
  }

  return { dailyRows, hourlyRows };
}

/** Keep projects whose models match selected tool channels; recompute totals. */
export function filterProjectRowsBySources(
  rows: DashboardProjectUsageRow[],
  selectedSources: string[],
): DashboardProjectUsageRow[] {
  if (selectedSources.length === 0) return rows;

  const selected = new Set(selectedSources);
  const next: DashboardProjectUsageRow[] = [];

  for (const row of rows) {
    const models = row.models.filter((model) =>
      sourceInSet(model.source, selected),
    );
    if (models.length === 0) continue;

    const tokens = models.reduce((sum, model) => sum + model.tokens, 0);
    if (tokens <= 0) continue;
    const costUsd = models.reduce((sum, model) => sum + model.costUsd, 0);

    next.push({
      ...row,
      tokens,
      costUsd,
      models: models.map((model) => ({
        ...model,
        pct: tokens > 0 ? Math.round((model.tokens / tokens) * 1_000) / 10 : 0,
      })),
    });
  }

  return next.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Build tool / model pie rows from visible tool usage.
 * Uses source keys as tool ids and chart colors by rank (not source brand color).
 */
export function buildToolModelDistributions(
  toolRows: DashboardToolUsageRow[],
): {
  tools: DashboardDistributionRow[];
  models: DashboardDistributionRow[];
} {
  const activeTools = toolRows
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const tools: DashboardDistributionRow[] = activeTools.map((row, index) => ({
    id: row.source,
    label: sourceLabel(row.source),
    color: chartColor(index),
    tokens: row.tokens,
    costUsd: row.costUsd,
    durationMinutes: 0,
  }));

  const modelTotals = new Map<string, { tokens: number; costUsd: number }>();
  for (const tool of activeTools) {
    for (const model of tool.models) {
      if (!model.model || model.tokens <= 0) continue;
      const entry = modelTotals.get(model.model) ?? { tokens: 0, costUsd: 0 };
      entry.tokens += model.tokens;
      entry.costUsd += model.costUsd;
      modelTotals.set(model.model, entry);
    }
  }

  const models: DashboardDistributionRow[] = [...modelTotals.entries()]
    .sort(([, a], [, b]) => b.tokens - a.tokens)
    .map(([model, usage], index) => ({
      id: model,
      label: model,
      color: chartColor(index),
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      durationMinutes: 0,
    }));

  return { tools, models };
}

function scaleDailyTrendRow(
  row: DashboardDailyUsageRow,
  share: number,
): DashboardDailyUsageRow {
  if (share === 1) return row;
  if (share <= 0) {
    return {
      ...row,
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMinutes: 0,
    };
  }

  const inputTokens = Math.round(row.inputTokens * share);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.round(row.cachedInputTokens * share),
  );
  return {
    ...row,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens: Math.round(row.outputTokens * share),
    totalTokens: Math.round(row.totalTokens * share),
    costUsd: row.costUsd * share,
    durationMinutes: Math.round(row.durationMinutes * share),
  };
}

function scaleHourlyTrendRow(
  row: DashboardHourlyUsageRow,
  share: number,
): DashboardHourlyUsageRow {
  if (share === 1) return row;
  if (share <= 0) {
    return {
      ...row,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMinutes: 0,
    };
  }

  const inputTokens = Math.round(row.inputTokens * share);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.round(row.cachedInputTokens * share),
  );
  return {
    ...row,
    inputTokens,
    cachedInputTokens,
    outputTokens: Math.round(row.outputTokens * share),
    totalTokens: Math.round(row.totalTokens * share),
    costUsd: row.costUsd * share,
    durationMinutes: Math.round(row.durationMinutes * share),
  };
}


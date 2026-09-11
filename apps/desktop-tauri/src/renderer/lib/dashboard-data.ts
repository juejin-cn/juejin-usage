import { parseDailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import { normalizeProjectName } from '@juejin-opensource/jusage-core/project-label';
import { addLocalDays } from '@juejin-opensource/jusage-core/timezone';
import type {
  DailyUsageRow,
  HourlyUsageRow,
  ModelBreakdownRow,
  ProjectBreakdownRow,
  UsageDataset,
} from './api.ts';
import {
  aggregateUsage,
  buildMetricChanges,
  buildProjectModelUsage,
  buildToolModelUsage,
  DASHBOARD_HOURS,
  DASHBOARD_WEEKDAYS,
  HEATMAP_LOOKBACK_DAYS,
  type DashboardDailyUsageRow,
  type DashboardDistributionRow,
  type DashboardDistributions,
  type DashboardHourlyUsageRow,
  type DashboardMetricTrends,
  type DashboardMockData,
  type DashboardUsageSummary,
  emptyDashboardData,
} from './dashboard-mock-data.ts';
import {
  localDateDaysAgo,
  localDateNow,
  localHourNow,
} from './stats-timezone.ts';
import { buildSummaryFromRange } from './time-range.ts';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const;

const SOURCE_LABELS: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  qoder: 'qoder',
  trae: 'trae',
  gemini: 'gemini',
  opencode: 'opencode',
  copilot: 'copilot',
  antigravity: 'antigravity',
  openclaw: 'openclaw',
  hermes: 'hermes',
  zcode: 'zcode',
  dsh: 'dsh',
  pi: 'pi',
  kimi: 'kimi',
  roocode: 'roocode',
  droid: 'droid',
  kiro: 'kiro',
  cline: 'cline',
  amp: 'amp',
  qwen: 'qwen-code',
  codebuddy: 'codebuddy',
  workbuddy: 'workbuddy',
  grok: 'grok',
  mimo: 'mimo',
  'every-code': 'every-code',
  omp: 'omp',
  'kilo-cli': 'kilo-cli',
  kilocode: 'kilocode',
  goose: 'goose',
  zed: 'zed',
  warp: 'warp',
};

/**
 * Project the root usage-page dataset into the richer visual Dashboard model.
 *
 * Daily / summary / model totals come from the API. Hourly charts use real
 * `tud-usage-hourly` buckets in Asia/Shanghai — unused hours stay 0.
 *
 * Callers should fetch at least `HEATMAP_LOOKBACK_DAYS` of daily history for
 * the heatmap, and enough hourly history to cover the selected range (expand
 * on date drill-down). Model breakdown follows `rangeDays` only.
 */
/** Keep only hour buckets that have already started (stats timezone). */
export function clipHourlyRowsToNow(
  rows: DashboardHourlyUsageRow[],
  now = new Date(),
): DashboardHourlyUsageRow[] {
  const upToHour = localHourNow(undefined, now);
  return rows.filter((row) => row.hour <= upToHour);
}

/** Sample/fallback dataset with today's hourly curve clipped to now. */
export function withClippedTodayHourly(
  data: DashboardMockData,
  now = new Date(),
): DashboardMockData {
  return {
    ...data,
    todayHourlyUsage: clipHourlyRowsToNow(data.todayHourlyUsage, now),
  };
}

export function buildDashboardDataFromDataset(
  dataset: UsageDataset,
  rangeDays: number,
): DashboardMockData {
  if (dataset.dailyRows.length === 0) {
    return emptyDashboardData;
  }

  // Calendar window (Asia/Shanghai), not sparse-array slice — a day with no
  // usage is absent from dailyRows, so slice(-1) would wrongly pick yesterday.
  const rangeEnd = localDateNow();
  const rangeStart = localDateDaysAgo(rangeDays);
  const selectedApiDays = dataset.dailyRows.filter(
    (row) => row.date >= rangeStart && row.date <= rangeEnd,
  );

  const heatmapStart = localDateDaysAgo(HEATMAP_LOOKBACK_DAYS);
  const heatmapApiDays = dataset.dailyRows.filter(
    (row) => row.date >= heatmapStart && row.date <= rangeEnd,
  );
  const selectedModels = dataset.modelRows.filter((row) => row.tokens > 0);
  const rangeSummary = buildSummaryFromRange(
    selectedApiDays,
    selectedModels,
    dataset.syncStatus?.statsSince || dataset.summary.statsSince,
    {
      tokens: dataset.summary.todayTokens,
      costUsd: dataset.summary.todayCostUsd,
    },
  );
  const allDailyUsage = selectedApiDays.map(normalizeDailyRow);
  const heatmapDailyUsage = heatmapApiDays.map(normalizeDailyRow);
  const heatmapDays = heatmapApiDays.map((row) => ({
    date: row.date,
    tokens: row.tokens,
    costUsd: row.costUsd,
    models: row.models ?? {},
    projects: row.projects,
  }));
  const dailyUsage = buildRecentSevenDays(allDailyUsage);
  const summary = aggregateDailyRows(allDailyUsage);
  const hourlyApiRows = dataset.hourlyRows ?? [];
  const todayHourlyUsage = buildFilledHourlyForDate(
    hourlyApiRows,
    rangeEnd,
    localHourNow(),
  );

  return {
    summary,
    rangeDailyUsage: allDailyUsage,
    heatmapDailyUsage,
    heatmapDays,
    modelRows: selectedModels,
    hourlyApiRows,
    todayHourlyUsage,
    dailyUsage,
    hourlyUsage: [],
    changes: buildMetricChanges(allDailyUsage),
    metricTrends: buildMetricTrends(
      dataset.dailyRows,
      dataset.hourlyRows ?? [],
      rangeDays,
    ),
    distributions: buildDistributions(
      rangeSummary.bySource,
      selectedModels,
      dataset.projectRows,
      summary,
    ),
    toolModelUsage: buildToolModelUsage(
      rangeSummary.bySource,
      summary.totalTokens,
    ),
    projectModelUsage: buildProjectModelUsage(
      dataset.projectRows,
      summary.totalTokens,
    ),
  };
}

/** First `YYYY-MM-DD` in a plain calendar or ISO midnight date string. */
export function calendarDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return match?.[1] ?? '';
}

/**
 * Fill `0..upToHour` (or 0..23) from sparse API hourly rows for one local date.
 * Hours without usage are zero — no synthetic allocation.
 * Multiple source rows for the same hour are summed.
 */
export function buildFilledHourlyForDate(
  apiRows: HourlyUsageRow[],
  date: string,
  upToHour?: number,
): DashboardHourlyUsageRow[] {
  const maxHour =
    upToHour === undefined ? 23 : Math.min(Math.max(upToHour, 0), 23);
  const targetDate = calendarDate(date);
  type HourAgg = {
    tokens: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  const byHour = new Map<number, HourAgg>();
  for (const row of apiRows) {
    if (!targetDate || calendarDate(row.date) !== targetDate) continue;
    const hour = Number(row.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const existing = byHour.get(hour) ?? {
      tokens: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };
    existing.tokens += row.tokens;
    existing.costUsd += row.costUsd;
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cachedInputTokens += row.cachedInputTokens;
    byHour.set(hour, existing);
  }
  const day = weekdayForDate(targetDate || date);

  return Array.from({ length: maxHour + 1 }, (_, hour) => {
    const api = byHour.get(hour);
    const hourLabel = DASHBOARD_HOURS[hour] ?? String(hour).padStart(2, '0');
    if (!api) return emptyHourlyRow(day, hour, hourLabel);

    const inputTokens = api.inputTokens;
    const outputTokens = api.outputTokens;
    const cachedInputTokens = Math.min(inputTokens, api.cachedInputTokens);
    return {
      day,
      hour,
      hourLabel,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: api.tokens > 0 ? api.tokens : inputTokens + outputTokens,
      costUsd: api.costUsd,
      durationMinutes: 0,
    };
  });
}

function emptyHourlyRow(
  day: (typeof DASHBOARD_WEEKDAYS)[number],
  hour: number,
  hourLabel: string,
): DashboardHourlyUsageRow {
  return {
    day,
    hour,
    hourLabel,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMinutes: 0,
  };
}

/**
 * Client-side single-day projection from heatmap history.
 * Keeps full `heatmapDays` / sparkline `dailyUsage`; scopes summary, trends,
 * tool/model panels, and distributions to `date` (YYYY-MM-DD, Asia/Shanghai).
 */
export function projectDashboardForDate(
  data: DashboardMockData,
  date: string,
): DashboardMockData {
  const apiDay = data.heatmapDays.find((row) => row.date === date);
  const existingDaily = data.heatmapDailyUsage.find((row) => row.date === date);
  const dayApi: DailyUsageRow = apiDay ?? {
    date,
    tokens: existingDaily?.totalTokens ?? 0,
    costUsd: existingDaily?.costUsd ?? 0,
    models: {},
  };
  const dailyRow =
    existingDaily ??
    normalizeDailyRow(dayApi, data.heatmapDailyUsage.length);

  const sourceFallback = buildModelSourceFallback(data.modelRows);
  const modelRows = buildModelRowsFromDailyModels(dayApi, sourceFallback);
  const projectRows = buildProjectRowsFromDaily(dayApi, sourceFallback);
  const rangeSummary = buildSummaryFromRange([dayApi], modelRows, '');
  const summary = aggregateDailyRows([dailyRow]);
  const today = localDateNow();
  const upToHour = date === today ? localHourNow() : undefined;
  const dayHourlyUsage = buildFilledHourlyForDate(
    data.hourlyApiRows,
    date,
    upToHour,
  );

  return {
    ...data,
    summary,
    rangeDailyUsage: [dailyRow],
    modelRows,
    todayHourlyUsage: dayHourlyUsage,
    hourlyUsage: [],
    changes: buildMetricChanges([dailyRow]),
    metricTrends: buildDayMetricTrends(date, data.heatmapDailyUsage),
    distributions: buildDistributions(
      rangeSummary.bySource,
      modelRows,
      projectRows,
      summary,
    ),
    toolModelUsage: buildToolModelUsage(
      rangeSummary.bySource,
      summary.totalTokens,
    ),
    projectModelUsage: buildProjectModelUsage(
      projectRows,
      summary.totalTokens,
    ),
  };
}

function buildModelSourceFallback(
  modelRows: ModelBreakdownRow[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of modelRows) {
    if (!map.has(row.model)) map.set(row.model, row.source);
  }
  return map;
}

function buildModelRowsFromDailyModels(
  day: DailyUsageRow,
  sourceFallback: Map<string, string>,
): ModelBreakdownRow[] {
  const entries = Object.entries(day.models ?? {}).filter(
    ([, tokens]) => tokens > 0,
  );
  if (entries.length === 0) return [];

  const tokenTotal = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
  const costs = allocateDecimal(
    day.costUsd,
    entries.map(([, tokens]) => tokens),
  );

  return entries
    .map(([key, tokens], index) => {
      const parsed = parseDailyModelKey(key);
      const source =
        parsed.source ?? sourceFallback.get(parsed.model) ?? 'unknown';
      return {
        model: parsed.model,
        source,
        tokens,
        costUsd: costs[index] ?? 0,
        pct:
          tokenTotal > 0
            ? Math.round((tokens / tokenTotal) * 1000) / 10
            : 0,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

/** Rebuild project breakdown from a daily row's compact projects map. */
function buildProjectRowsFromDaily(
  day: DailyUsageRow,
  sourceFallback: Map<string, string>,
): ProjectBreakdownRow[] {
  const collapsed = new Map<
    string,
    { project: string; tokens: number; models: Record<string, number> }
  >();
  for (const row of day.projects ?? []) {
    if (row.tokens <= 0) continue;
    const project = normalizeProjectName(row.project);
    const current = collapsed.get(project) ?? {
      project,
      tokens: 0,
      models: {},
    };
    current.tokens += row.tokens;
    for (const [key, tokens] of Object.entries(row.models ?? {})) {
      if (tokens <= 0) continue;
      current.models[key] = (current.models[key] ?? 0) + tokens;
    }
    collapsed.set(project, current);
  }
  const projects = Array.from(collapsed.values());
  if (projects.length === 0) return [];

  const dayTokenTotal = projects.reduce((sum, row) => sum + row.tokens, 0);
  const projectCosts = allocateDecimal(
    day.costUsd,
    projects.map((row) => row.tokens),
  );

  return projects
    .map((project, projectIndex) => {
      const modelEntries = Object.entries(project.models ?? {}).filter(
        ([, tokens]) => tokens > 0,
      );
      const modelCosts = allocateDecimal(
        projectCosts[projectIndex] ?? 0,
        modelEntries.map(([, tokens]) => tokens),
      );
      const models = modelEntries
        .map(([key, tokens], index) => {
          const parsed = parseDailyModelKey(key);
          const source =
            parsed.source ?? sourceFallback.get(parsed.model) ?? 'unknown';
          return {
            model: parsed.model,
            source,
            tokens,
            costUsd: modelCosts[index] ?? 0,
            pct:
              project.tokens > 0
                ? Math.round((tokens / project.tokens) * 1000) / 10
                : 0,
          };
        })
        .sort((a, b) => b.tokens - a.tokens);

      return {
        project: project.project,
        tokens: project.tokens,
        costUsd: projectCosts[projectIndex] ?? 0,
        pct:
          dayTokenTotal > 0
            ? Math.round((project.tokens / dayTokenTotal) * 1000) / 10
            : 0,
        models,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

function normalizeDailyRow(
  row: DailyUsageRow,
  _index?: number,
): DashboardDailyUsageRow {
  const inputRatio = 0.78;
  const cacheRatio = 0.2;
  const inputTokens = Math.round(row.tokens * inputRatio);
  const outputTokens = Math.max(0, row.tokens - inputTokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.round(inputTokens * cacheRatio),
  );
  const durationMinutes = 0;

  return {
    day: weekdayForDate(row.date),
    date: row.date,
    dateLabel: formatDateLabel(row.date),
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    totalTokens: row.tokens,
    costUsd: roundCurrency(row.costUsd),
    durationMinutes,
  };
}

function buildRecentSevenDays(
  rows: DashboardDailyUsageRow[],
): DashboardDailyUsageRow[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const endDate = parseUtcDate(rows.at(-1)?.date ?? localDateNow());

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(endDate);
    date.setUTCDate(endDate.getUTCDate() - (6 - index));
    const isoDate = date.toISOString().slice(0, 10);
    const existing = byDate.get(isoDate);
    if (existing) return existing;

    return {
      day: weekdayForDate(isoDate),
      date: isoDate,
      dateLabel: formatDateLabel(isoDate),
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMinutes: 0,
    };
  });
}

function aggregateDailyRows(
  rows: DashboardDailyUsageRow[],
): DashboardUsageSummary {
  return aggregateUsage(
    rows.map((row) => ({
      day: row.day,
      hour: 0,
      hourLabel: '00',
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      costUsd: row.costUsd,
      durationMinutes: row.durationMinutes,
    })),
  );
}

/**
 * Compares the selected period with the immediately preceding period of the
 * same length. Today is compared with yesterday through the current hour so a
 * partial day is never compared with a completed day.
 */
function buildMetricTrends(
  dailyRows: DailyUsageRow[],
  hourlyRows: HourlyUsageRow[],
  rangeDays: number,
): DashboardMetricTrends {
  const today = localDateNow();
  if (rangeDays === 1) {
    const currentHour = localHourNow();
    const previousDay = addLocalDays(today, -1);
    return buildMetricTrendSet(
      sumHourlyMetrics(hourlyRows, today, currentHour),
      sumHourlyMetrics(hourlyRows, previousDay, currentHour),
    );
  }

  const currentStart = addLocalDays(today, -(rangeDays - 1));
  const previousStart = addLocalDays(currentStart, -rangeDays);
  const previousEnd = addLocalDays(currentStart, -1);
  return buildMetricTrendSet(
    sumDailyMetrics(dailyRows, currentStart, today),
    sumDailyMetrics(dailyRows, previousStart, previousEnd),
  );
}

/** A heatmap day uses the preceding calendar day as its comparison baseline. */
function buildDayMetricTrends(
  date: string,
  rows: DashboardDailyUsageRow[],
): DashboardMetricTrends {
  const current = rows.find((row) => row.date === date);
  const previousDate = addLocalDays(date, -1);
  const previous = rows.find((row) => row.date === previousDate);
  return buildMetricTrendSet(
    aggregateDailyRows(current ? [current] : []),
    aggregateDailyRows(previous ? [previous] : []),
  );
}

function sumDailyMetrics(
  rows: DailyUsageRow[],
  from: string,
  to: string,
): DashboardUsageSummary {
  return aggregateDailyRows(
    rows
      .filter((row) => row.date >= from && row.date <= to)
      .map(normalizeDailyRow),
  );
}

function sumHourlyMetrics(
  rows: HourlyUsageRow[],
  date: string,
  throughHour: number,
): DashboardUsageSummary {
  return aggregateUsage(
    rows
      .filter((row) => row.date === date && row.hour <= throughHour)
      .map((row) => ({
        day: weekdayForDate(row.date),
        hour: row.hour,
        hourLabel: String(row.hour).padStart(2, '0'),
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.tokens,
        costUsd: row.costUsd,
        durationMinutes: 0,
      })),
  );
}

function buildMetricTrendSet(
  current: DashboardUsageSummary,
  previous: DashboardUsageSummary,
): DashboardMetricTrends {
  return {
    inputTokens: buildMetricTrend(current.inputTokens, previous.inputTokens),
    outputTokens: buildMetricTrend(current.outputTokens, previous.outputTokens),
    totalTokens: buildMetricTrend(current.totalTokens, previous.totalTokens),
    totalCostUsd: buildMetricTrend(current.totalCostUsd, previous.totalCostUsd),
  };
}

function buildMetricTrend(
  current: number,
  previous: number,
): DashboardMetricTrends['totalTokens'] {
  if (current <= 0 || previous <= 0) return null;
  return {
    changePct: ((current - previous) / previous) * 100,
    changeValue: current - previous,
  };
}

function collapseProjectDistribution(
  projects: ProjectBreakdownRow[],
): Array<{ label: string; tokens: number; costUsd: number }> {
  const byName = new Map<
    string,
    { label: string; tokens: number; costUsd: number }
  >();
  for (const row of projects) {
    const name = normalizeProjectName(row.project);
    const label = name === 'unknown' ? '未知项目' : name;
    const current = byName.get(name) ?? { label, tokens: 0, costUsd: 0 };
    current.tokens += row.tokens;
    current.costUsd += row.costUsd;
    byName.set(name, current);
  }
  return Array.from(byName.values());
}

function buildDistributions(
  sources: UsageDataset['summary']['bySource'],
  models: ModelBreakdownRow[],
  projects: ProjectBreakdownRow[],
  summary: DashboardUsageSummary,
): DashboardDistributions {
  const toolRows = sources.map((source) => ({
    label: SOURCE_LABELS[source.source] ?? source.source,
    tokens: source.tokens,
    costUsd: source.costUsd,
  }));
  const modelGroups = new Map<
    string,
    { label: string; tokens: number; costUsd: number }
  >();

  for (const row of models) {
    const current = modelGroups.get(row.model) ?? {
      label: row.model,
      tokens: 0,
      costUsd: 0,
    };
    current.tokens += row.tokens;
    current.costUsd += row.costUsd;
    modelGroups.set(row.model, current);
  }

  return {
    tools: toolRows.length > 0 ? normalizeDistribution(toolRows, summary, 6) : [],
    models:
      modelGroups.size > 0
        ? normalizeDistribution([...modelGroups.values()], summary, 6)
        : [],
    terminals: [],
    projects:
      projects.length > 0
        ? normalizeDistribution(
            collapseProjectDistribution(projects),
            summary,
            6,
          )
        : [],
  };
}

function normalizeDistribution(
  rows: Array<{ label: string; tokens: number; costUsd: number }>,
  summary: DashboardUsageSummary,
  limit = 8,
): DashboardDistributionRow[] {
  const sorted = rows
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const visible = sorted.slice(0, limit);
  const overflow = sorted.slice(limit);
  if (overflow.length > 0) {
    visible.push({
      label: '其他',
      tokens: overflow.reduce((total, row) => total + row.tokens, 0),
      costUsd: overflow.reduce((total, row) => total + row.costUsd, 0),
    });
  }

  const tokenValues = allocateInteger(
    summary.totalTokens,
    visible.map((row) => row.tokens),
  );
  const costValues = allocateDecimal(
    summary.totalCostUsd,
    visible.map((row) => row.costUsd || row.tokens),
  );
  const durationValues = allocateInteger(
    summary.totalDurationMinutes,
    visible.map((row) => row.tokens),
  );

  return visible.map((row, index) => ({
    id: slugify(row.label) || `item-${index}`,
    label: row.label,
    color: CHART_COLORS[index % CHART_COLORS.length],
    tokens: tokenValues[index] ?? 0,
    costUsd: costValues[index] ?? 0,
    durationMinutes: durationValues[index] ?? 0,
  }));
}

function allocateInteger(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safeTotal = Math.max(0, Math.round(total));
  const weightTotal = weights.reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );
  if (weightTotal <= 0) return weights.map(() => 0);

  const exact = weights.map(
    (weight) => (Math.max(0, weight) / weightTotal) * safeTotal,
  );
  const values = exact.map(Math.floor);
  let remainder = safeTotal - values.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let index = 0; index < remainder; index += 1) {
    const target = order[index % order.length];
    values[target.index] += 1;
  }

  return values;
}

function allocateDecimal(total: number, weights: number[]): number[] {
  return allocateInteger(Math.round(total * 100), weights).map(
    (value) => value / 100,
  );
}

function weekdayForDate(value: string) {
  const date = parseUtcDate(value);
  const mondayIndex = (date.getUTCDay() + 6) % 7;
  return DASHBOARD_WEEKDAYS[mondayIndex];
}

function parseUtcDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function formatDateLabel(value: string) {
  const [, month = '', day = ''] = value.slice(0, 10).split('-');
  return `${Number(month)}/${Number(day)}`;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Reuse `previous` references for fields whose content did not change so
 * memoized consumers (heatmap, Recharts cards) can skip re-rendering.
 *
 * Range switches rebuild the whole model, but the heatmap window (365d daily)
 * and other range-independent fields usually stay identical — keeping their
 * references avoids remounting the most expensive components.
 */
export function stabilizeDashboardData(
  previous: DashboardMockData,
  next: DashboardMockData,
): DashboardMockData {
  if (
    previous === next ||
    previous === emptyDashboardData ||
    next === emptyDashboardData
  ) {
    return next;
  }

  let reusedAll = true;
  const merged: DashboardMockData = { ...next };
  const reuse = <K extends keyof DashboardMockData>(key: K) => {
    merged[key] = previous[key];
  };
  for (const key of Object.keys(next) as Array<keyof DashboardMockData>) {
    if (deepEqualJson(previous[key], next[key])) {
      reuse(key);
    } else {
      reusedAll = false;
    }
  }
  return reusedAll ? previous : merged;
}

/** Structural equality for JSON-like data (plain objects, arrays, primitives). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqualJson(a[index], b[index])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false;
    if (!deepEqualJson(aRecord[key], bRecord[key])) return false;
  }
  return true;
}

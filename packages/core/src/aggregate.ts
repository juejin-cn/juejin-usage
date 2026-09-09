import {
  aggregateLocalMetrics,
  emptyLocalMetrics,
  mergeLocalMetrics,
  metricsFromBucket,
  type LocalUsageMetrics,
} from './local-metrics.js';
import type {
  DailyUsageResponse,
  HourlyUsageResponse,
  IngestBucket,
  ModelBreakdownResponse,
  QueueBucket,
  UsageSummary,
} from './types.js';
import { dailyModelKey } from './daily-model-key.js';
import { normalizeProjectName } from './project-label.js';
import { computeRowCost, computeTokens, roundCostUsd } from './pricing/index.js';
import { ingestBucketKey } from './queue/keys.js';
import {
  DEFAULT_STATS_TIMEZONE,
  localDateAndHour,
  localDateDaysAgo,
  localDateNow,
} from './timezone.js';

export function aggregateUsageSummary(
  rows: QueueBucket[],
  statsSince: string,
  timeZone: string = DEFAULT_STATS_TIMEZONE,
): UsageSummary {
  const bySourceMap = new Map<
    string,
    {
      tokens: number;
      costUsd: number;
      localMetrics: LocalUsageMetrics;
      models: Map<
        string,
        { tokens: number; costUsd: number; localMetrics: LocalUsageMetrics }
      >;
    }
  >();
  let totalTokens = 0;
  let totalCostUsd = 0;

  const today = localDateNow(timeZone);
  let todayTokens = 0;
  let todayCostUsd = 0;

  for (const row of rows) {
    const tokens = computeTokens(row);
    const cost = computeRowCost(row);
    totalTokens += tokens;
    totalCostUsd += cost;

    const src = bySourceMap.get(row.source) ?? {
      tokens: 0,
      costUsd: 0,
      localMetrics: emptyLocalMetrics(),
      models: new Map<
        string,
        { tokens: number; costUsd: number; localMetrics: LocalUsageMetrics }
      >(),
    };
    src.tokens += tokens;
    src.costUsd += cost;
    src.localMetrics = mergeLocalMetrics([
      src.localMetrics,
      metricsFromBucket(row),
    ]);

    const model = src.models.get(row.model) ?? {
      tokens: 0,
      costUsd: 0,
      localMetrics: emptyLocalMetrics(),
    };
    model.tokens += tokens;
    model.costUsd += cost;
    model.localMetrics = mergeLocalMetrics([
      model.localMetrics,
      metricsFromBucket(row),
    ]);
    src.models.set(row.model, model);
    bySourceMap.set(row.source, src);

    const { date } = localDateAndHour(row.hour_start, timeZone);
    if (date === today) {
      todayTokens += tokens;
      todayCostUsd += cost;
    }
  }

  const bySource = Array.from(bySourceMap.entries())
    .map(([source, v]) => ({
      source,
      tokens: v.tokens,
      costUsd: roundCostUsd(v.costUsd),
      localMetrics: v.localMetrics,
      pct: pct(v.tokens, totalTokens),
      models: Array.from(v.models.entries())
        .map(([model, m]) => ({
          model,
          tokens: m.tokens,
          costUsd: roundCostUsd(m.costUsd),
          localMetrics: m.localMetrics,
          pct: pct(m.tokens, v.tokens),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    localMetrics: aggregateLocalMetrics(rows),
    todayLocalMetrics: aggregateLocalMetrics(
      rows.filter(
        (row) => localDateAndHour(row.hour_start, timeZone).date === today,
      ),
    ),
    totalTokens,
    totalCostUsd: roundCostUsd(totalCostUsd),
    todayTokens,
    todayCostUsd: roundCostUsd(todayCostUsd),
    statsSince,
    bySource,
  };
}

export function aggregateForIngest(rows: QueueBucket[]): IngestBucket[] {
  const map = new Map<string, IngestBucket>();
  for (const row of rows) {
    const key = ingestBucketKey(row);
    const reported =
      row.reported_cost_usd != null &&
      Number.isFinite(row.reported_cost_usd) &&
      row.reported_cost_usd > 0
        ? row.reported_cost_usd
        : undefined;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        hour_start: row.hour_start,
        source: row.source,
        model: row.model,
        ...(row.collector ? { collector: row.collector } : {}),
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cached_input_tokens: row.cached_input_tokens,
        cache_creation_input_tokens: row.cache_creation_input_tokens,
        reasoning_output_tokens: row.reasoning_output_tokens,
        total_tokens: row.total_tokens,
        conversation_count: row.conversation_count,
        ...(reported != null ? { reported_cost_usd: reported } : {}),
      });
    } else {
      existing.input_tokens += row.input_tokens;
      existing.output_tokens += row.output_tokens;
      existing.cached_input_tokens += row.cached_input_tokens;
      existing.cache_creation_input_tokens += row.cache_creation_input_tokens;
      existing.reasoning_output_tokens += row.reasoning_output_tokens;
      existing.total_tokens += row.total_tokens;
      existing.conversation_count += row.conversation_count;
      if (reported != null) {
        existing.reported_cost_usd = (existing.reported_cost_usd ?? 0) + reported;
      }
    }
  }
  return Array.from(map.values());
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function statsSinceLocalDate(
  statsSince: string,
  timeZone: string,
): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(statsSince)) return statsSince;
  return localDateAndHour(statsSince, timeZone).date;
}

export function resolveAggregateWindow(
  days: number,
  statsSince: string,
  timeZone: string = DEFAULT_STATS_TIMEZONE,
  options?: { fromDate?: string; toDate?: string },
): { fromDate: string; toDate: string; statsSinceDate: string } {
  const today = localDateNow(timeZone);
  const fromDate = options?.fromDate ?? localDateDaysAgo(days, timeZone);
  const toDate = options?.toDate ?? today;
  return {
    fromDate,
    toDate,
    statsSinceDate: statsSinceLocalDate(statsSince, timeZone),
  };
}

export function aggregateDaily(
  rows: QueueBucket[],
  days: number,
  statsSince: string,
  timeZone: string = DEFAULT_STATS_TIMEZONE,
  options?: { fromDate?: string; toDate?: string },
): DailyUsageResponse {
  const { fromDate, toDate, statsSinceDate } = resolveAggregateWindow(
    days,
    statsSince,
    timeZone,
    options,
  );

  const byDay = new Map<
    string,
    {
      tokens: number;
      costUsd: number;
      localMetrics: LocalUsageMetrics;
      sources: Map<
        string,
        { tokens: number; costUsd: number; localMetrics: LocalUsageMetrics }
      >;
      models: Map<string, number>;
      projects: Map<string, { tokens: number; models: Map<string, number> }>;
    }
  >();

  for (const row of rows) {
    const { date } = localDateAndHour(row.hour_start, timeZone);
    if (date < fromDate || date > toDate || date < statsSinceDate) continue;

    const tokens = computeTokens(row);
    const cost = computeRowCost(row);
    const day = byDay.get(date) ?? {
      tokens: 0,
      costUsd: 0,
      localMetrics: emptyLocalMetrics(),
      sources: new Map(),
      models: new Map<string, number>(),
      projects: new Map(),
    };
    day.tokens += tokens;
    day.costUsd += cost;
    const metrics = metricsFromBucket(row);
    day.localMetrics = mergeLocalMetrics([day.localMetrics, metrics]);
    const source = day.sources.get(row.source) ?? {
      tokens: 0,
      costUsd: 0,
      localMetrics: emptyLocalMetrics(),
    };
    source.tokens += tokens;
    source.costUsd += cost;
    source.localMetrics = mergeLocalMetrics([source.localMetrics, metrics]);
    day.sources.set(row.source, source);
    const modelKey = dailyModelKey(row.source, row.model);
    day.models.set(modelKey, (day.models.get(modelKey) ?? 0) + tokens);

    const projectName = normalizeProjectName(row.project || 'unknown');
    const project = day.projects.get(projectName) ?? {
      tokens: 0,
      models: new Map<string, number>(),
    };
    project.tokens += tokens;
    project.models.set(modelKey, (project.models.get(modelKey) ?? 0) + tokens);
    day.projects.set(projectName, project);
    byDay.set(date, day);
  }

  const daysOut = Array.from(byDay.entries())
    .map(([date, v]) => ({
      date,
      tokens: v.tokens,
      costUsd: roundCostUsd(v.costUsd),
      localMetrics: v.localMetrics,
      sources: Array.from(v.sources, ([source, data]) => ({
        ...data,
        source,
        costUsd: roundCostUsd(data.costUsd),
      })),
      models: Object.fromEntries(
        Array.from(v.models.entries()).sort((a, b) => b[1] - a[1]),
      ),
      projects: Array.from(v.projects.entries())
        .map(([project, p]) => ({
          project,
          tokens: p.tokens,
          models: Object.fromEntries(
            Array.from(p.models.entries()).sort((a, b) => b[1] - a[1]),
          ),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { days: daysOut };
}

/**
 * Aggregate queue buckets into local-timezone hour rows, split by source.
 * Only hours with usage are returned; callers fill gaps with zeros.
 */
export function aggregateHourly(
  rows: QueueBucket[],
  days: number,
  statsSince: string,
  timeZone: string = DEFAULT_STATS_TIMEZONE,
  bounds?: { fromDate?: string; toDate?: string },
): HourlyUsageResponse {
  const { fromDate, toDate, statsSinceDate } = resolveAggregateWindow(
    days,
    statsSince,
    timeZone,
    bounds,
  );

  const byHour = new Map<
    string,
    {
      date: string;
      hour: number;
      source: string;
      tokens: number;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      localMetrics: LocalUsageMetrics;
    }
  >();

  for (const row of rows) {
    const { date, hour } = localDateAndHour(row.hour_start, timeZone);
    if (date < fromDate || date > toDate || date < statsSinceDate) continue;

    const source = row.source || 'unknown';
    const key = `${date}T${String(hour).padStart(2, '0')}|${source}`;
    const tokens = computeTokens(row);
    const cost = computeRowCost(row);
    const existing = byHour.get(key) ?? {
      date,
      hour,
      source,
      tokens: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      localMetrics: emptyLocalMetrics(),
    };
    existing.tokens += tokens;
    existing.costUsd += cost;
    existing.inputTokens += row.input_tokens || 0;
    existing.outputTokens += row.output_tokens || 0;
    existing.cachedInputTokens += row.cached_input_tokens || 0;
    existing.localMetrics = mergeLocalMetrics([
      existing.localMetrics,
      metricsFromBucket(row),
    ]);
    byHour.set(key, existing);
  }

  const hours = Array.from(byHour.values())
    .map((h) => ({
      ...h,
      costUsd: roundCostUsd(h.costUsd),
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.hour - b.hour ||
        a.source.localeCompare(b.source),
    );

  return { hours, timeZone };
}

export function aggregateModelBreakdown(
  rows: QueueBucket[],
  days: number,
  statsSince: string,
  timeZone: string = DEFAULT_STATS_TIMEZONE,
  bounds?: { fromDate?: string; toDate?: string },
): ModelBreakdownResponse {
  const { fromDate, toDate, statsSinceDate } = resolveAggregateWindow(
    days,
    statsSince,
    timeZone,
    bounds,
  );

  const byModel = new Map<
    string,
    {
      model: string;
      source: string;
      tokens: number;
      costUsd: number;
      localMetrics: LocalUsageMetrics;
    }
  >();
  const byProject = new Map<
    string,
    {
      project: string;
      localMetrics: LocalUsageMetrics;
      tokens: number;
      costUsd: number;
      models: Map<
        string,
        {
          model: string;
          source: string;
          tokens: number;
          costUsd: number;
          localMetrics: LocalUsageMetrics;
        }
      >;
    }
  >();
  let totalTokens = 0;

  for (const row of rows) {
    const { date } = localDateAndHour(row.hour_start, timeZone);
    if (date < fromDate || date > toDate || date < statsSinceDate) continue;

    const tokens = computeTokens(row);
    const cost = computeRowCost(row);
    const key = `${row.source}\0${row.model}`;
    const entry = byModel.get(key) ?? {
      model: row.model,
      source: row.source,
      tokens: 0,
      costUsd: 0,
      localMetrics: emptyLocalMetrics(),
    };
    entry.tokens += tokens;
    entry.costUsd += cost;
    entry.localMetrics = mergeLocalMetrics([
      entry.localMetrics,
      metricsFromBucket(row),
    ]);
    byModel.set(key, entry);

    const projectName = normalizeProjectName(row.project || 'unknown');
    const project = byProject.get(projectName) ?? {
      project: projectName,
      localMetrics: emptyLocalMetrics(),
      tokens: 0,
      costUsd: 0,
      models: new Map(),
    };
    project.tokens += tokens;
    project.costUsd += cost;
    project.localMetrics = mergeLocalMetrics([
      project.localMetrics,
      metricsFromBucket(row),
    ]);
    const projectModel = project.models.get(key) ?? {
      model: row.model,
      source: row.source,
      tokens: 0,
      costUsd: 0,
      localMetrics: emptyLocalMetrics(),
    };
    projectModel.tokens += tokens;
    projectModel.costUsd += cost;
    projectModel.localMetrics = mergeLocalMetrics([
      projectModel.localMetrics,
      metricsFromBucket(row),
    ]);
    project.models.set(key, projectModel);
    byProject.set(projectName, project);
    totalTokens += tokens;
  }

  const models = Array.from(byModel.values())
    .map((v) => ({
      model: v.model,
      source: v.source,
      tokens: v.tokens,
      costUsd: roundCostUsd(v.costUsd),
      localMetrics: v.localMetrics,
      pct: pct(v.tokens, totalTokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const projects = Array.from(byProject.values())
    .map((v) => ({
      project: v.project,
      tokens: v.tokens,
      costUsd: roundCostUsd(v.costUsd),
      localMetrics: v.localMetrics,
      pct: pct(v.tokens, totalTokens),
      models: Array.from(v.models.values())
        .map((m) => ({
          model: m.model,
          source: m.source,
          tokens: m.tokens,
          costUsd: roundCostUsd(m.costUsd),
          localMetrics: m.localMetrics,
          pct: pct(m.tokens, v.tokens),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return { models, projects };
}

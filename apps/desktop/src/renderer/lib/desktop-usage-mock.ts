import { dailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import type { LocalUsageMetrics } from '@juejin-opensource/jusage-core/local-metrics';
import type {
  DailyUsageResponse,
  DailyUsageRow,
  HourlyUsageRow,
  ModelBreakdownRow,
  ProjectBreakdownRow,
  SyncStatus,
  UsageDataset,
  UsageSummary,
} from './api';
import { localDateDaysAgo, localDateNow } from './stats-timezone';

const PROFILES = [
  { source: 'claude-code', model: 'claude-sonnet-4-6', project: 'ai-usage', scale: 1.45 },
  { source: 'claude-code', model: 'claude-opus-4-6', project: 'dashboard', scale: 0.82 },
  { source: 'codex', model: 'gpt-5.4', project: 'ai-usage', scale: 1.15 },
  { source: 'cursor', model: 'composer-2', project: 'marketing-site', scale: 0.7 },
] as const;

const LOOKBACK_DAYS = 365;

interface Slice {
  source: string;
  model: string;
  project: string;
  tokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  requestCount: number;
}

interface DayUsage {
  date: string;
  slices: Slice[];
}

function unitInterval(seed: number): number {
  const value = Math.imul(seed ^ (seed >>> 16), 0x7feb352d);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}

function metrics(slice: Pick<Slice, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'requestCount'>): LocalUsageMetrics {
  const gross = slice.inputTokens + slice.cachedInputTokens;
  return {
    version: 1,
    uncachedInputTokens: slice.inputTokens,
    cacheReadTokens: slice.cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: slice.outputTokens,
    reasoningOutputTokens: 0,
    requestCount: slice.requestCount,
    knownRequestCount: slice.requestCount,
    cacheHitRate: gross > 0 ? slice.cachedInputTokens / gross : null,
    missingReasons: [],
  };
}

function buildDays(): DayUsage[] {
  const today = localDateNow();
  return Array.from({ length: LOOKBACK_DAYS }, (_, index) => {
    const ago = LOOKBACK_DAYS - 1 - index;
    const date = localDateDaysAgo(ago);
    const weekend = new Date(`${date}T12:00:00+08:00`).getUTCDay() % 6 === 0;
    const wave = 0.72 + unitInterval(index * 97 + 3) * 0.56;
    const dayScale = (weekend ? 0.42 : 1) * wave;
    const slices = PROFILES.map((profile, profileIndex) => {
      const tokens = Math.round((18_000 + unitInterval(index * 13 + profileIndex * 29) * 92_000) * profile.scale * dayScale);
      const inputTokens = Math.round(tokens * 0.46);
      const cachedInputTokens = Math.round(tokens * 0.22);
      const outputTokens = Math.max(0, tokens - inputTokens - cachedInputTokens);
      return {
        source: profile.source,
        model: profile.model,
        project: profile.project,
        tokens,
        costUsd: Math.round((inputTokens * 0.000003 + outputTokens * 0.000015) * 100) / 100,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        requestCount: Math.max(1, Math.round(tokens / 22_000)),
      };
    }).filter((slice) => slice.tokens > 0);
    return { date: date || today, slices };
  });
}

let cachedDays: DayUsage[] | null = null;

function days(): DayUsage[] {
  if (!cachedDays || cachedDays.at(-1)?.date !== localDateNow()) cachedDays = buildDays();
  return cachedDays;
}

function takeDays(count: number): DayUsage[] {
  return days().slice(-Math.max(1, count));
}

function sumSlices(rows: DayUsage[]): Slice[] {
  return rows.flatMap((row) => row.slices);
}

function toDailyRow(row: DayUsage): DailyUsageRow {
  const tokens = row.slices.reduce((sum, slice) => sum + slice.tokens, 0);
  const costUsd = row.slices.reduce((sum, slice) => sum + slice.costUsd, 0);
  const inputTokens = row.slices.reduce((sum, slice) => sum + slice.inputTokens, 0);
  const outputTokens = row.slices.reduce((sum, slice) => sum + slice.outputTokens, 0);
  const cachedInputTokens = row.slices.reduce((sum, slice) => sum + slice.cachedInputTokens, 0);
  const requestCount = row.slices.reduce((sum, slice) => sum + slice.requestCount, 0);
  const models: Record<string, number> = {};
  for (const slice of row.slices) {
    const key = dailyModelKey(slice.source, slice.model);
    models[key] = (models[key] ?? 0) + slice.tokens;
  }
  return {
    date: row.date,
    tokens,
    costUsd,
    models,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens: 0,
    projects: Object.values(row.slices.reduce<Record<string, { project: string; tokens: number; models: Record<string, number> }>>((acc, slice) => {
      const entry = acc[slice.project] ?? { project: slice.project, tokens: 0, models: {} };
      entry.tokens += slice.tokens;
      entry.models[slice.model] = (entry.models[slice.model] ?? 0) + slice.tokens;
      acc[slice.project] = entry;
      return acc;
    }, {})),
    sources: row.slices.map((slice) => ({
      source: slice.source,
      tokens: slice.tokens,
      costUsd: slice.costUsd,
      localMetrics: metrics(slice),
    })),
    localMetrics: metrics({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      requestCount,
    }),
  };
}

function hourlyRows(count: number): HourlyUsageRow[] {
  const rows: HourlyUsageRow[] = [];
  for (const day of takeDays(count)) {
    for (const slice of day.slices) {
      for (let hour = 0; hour < 24; hour += 1) {
        const weight = hour >= 9 && hour <= 12 ? 1.4 : hour >= 19 && hour <= 22 ? 1.7 : hour >= 1 && hour <= 6 ? 0.15 : 0.55;
        const share = weight / 18.2;
        const tokens = Math.round(slice.tokens * share);
        if (tokens <= 0) continue;
        const inputTokens = Math.round(slice.inputTokens * share);
        const outputTokens = Math.round(slice.outputTokens * share);
        const cachedInputTokens = Math.round(slice.cachedInputTokens * share);
        const requestCount = Math.max(0, Math.round(slice.requestCount * share));
        rows.push({
          date: day.date,
          hour,
          source: slice.source,
          tokens,
          costUsd: Math.round(slice.costUsd * share * 100) / 100,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          localMetrics: metrics({ inputTokens, outputTokens, cachedInputTokens, requestCount }),
        });
      }
    }
  }
  return rows;
}

function modelRows(count: number): ModelBreakdownRow[] {
  const totals = new Map<string, ModelBreakdownRow>();
  let grand = 0;
  for (const slice of sumSlices(takeDays(count))) {
    grand += slice.tokens;
    const key = dailyModelKey(slice.source, slice.model);
    const current = totals.get(key) ?? {
      model: slice.model,
      source: slice.source,
      tokens: 0,
      costUsd: 0,
      pct: 0,
    };
    current.tokens += slice.tokens;
    current.costUsd += slice.costUsd;
    totals.set(key, current);
  }
  return [...totals.values()]
    .map((row) => ({ ...row, costUsd: roundMoney(row.costUsd), pct: grand > 0 ? (row.tokens / grand) * 100 : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
}

function projectRows(count: number): ProjectBreakdownRow[] {
  const totals = new Map<string, ProjectBreakdownRow>();
  let grand = 0;
  for (const slice of sumSlices(takeDays(count))) {
    grand += slice.tokens;
    const current = totals.get(slice.project) ?? {
      project: slice.project,
      tokens: 0,
      costUsd: 0,
      pct: 0,
      models: [],
    };
    current.tokens += slice.tokens;
    current.costUsd += slice.costUsd;
    const models = current.models ?? [];
    const existing = models.find((model) => model.model === slice.model && model.source === slice.source);
    if (existing) {
      existing.tokens += slice.tokens;
      existing.costUsd += slice.costUsd;
    } else {
      models.push({
        model: slice.model,
        source: slice.source,
        tokens: slice.tokens,
        costUsd: slice.costUsd,
        pct: 0,
      });
    }
    current.models = models;
    totals.set(slice.project, current);
  }
  return [...totals.values()]
    .map((row) => ({
      ...row,
      costUsd: roundMoney(row.costUsd),
      pct: grand > 0 ? (row.tokens / grand) * 100 : 0,
      models: (row.models ?? [])
        .map((model) => ({
          ...model,
          costUsd: roundMoney(model.costUsd),
          pct: row.tokens > 0 ? (model.tokens / row.tokens) * 100 : 0,
        }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function summaryFor(rows: DayUsage[]): UsageSummary {
  const today = rows.at(-1);
  const slices = sumSlices(rows);
  const bySource = new Map<string, UsageSummary['bySource'][number]>();
  for (const slice of slices) {
    const current = bySource.get(slice.source) ?? {
      source: slice.source,
      tokens: 0,
      costUsd: 0,
      pct: 0,
      models: [],
    };
    current.tokens += slice.tokens;
    current.costUsd += slice.costUsd;
    const model = current.models.find((item) => item.model === slice.model);
    if (model) {
      model.tokens += slice.tokens;
      model.costUsd += slice.costUsd;
    } else {
      current.models.push({ model: slice.model, tokens: slice.tokens, costUsd: slice.costUsd, pct: 0 });
    }
    bySource.set(slice.source, current);
  }
  const totalTokens = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  const sources = [...bySource.values()].map((source) => ({
    ...source,
    costUsd: roundMoney(source.costUsd),
    pct: totalTokens > 0 ? (source.tokens / totalTokens) * 100 : 0,
    models: source.models.map((model) => ({
      ...model,
      costUsd: roundMoney(model.costUsd),
      pct: source.tokens > 0 ? (model.tokens / source.tokens) * 100 : 0,
    })),
  }));
  const todaySlices = today?.slices ?? [];
  return {
    totalTokens,
    totalCostUsd: roundMoney(slices.reduce((sum, slice) => sum + slice.costUsd, 0)),
    todayTokens: todaySlices.reduce((sum, slice) => sum + slice.tokens, 0),
    todayCostUsd: roundMoney(todaySlices.reduce((sum, slice) => sum + slice.costUsd, 0)),
    statsSince: rows[0]?.date ?? localDateNow(),
    bySource: sources,
    localMetrics: metrics({
      inputTokens: slices.reduce((sum, slice) => sum + slice.inputTokens, 0),
      outputTokens: slices.reduce((sum, slice) => sum + slice.outputTokens, 0),
      cachedInputTokens: slices.reduce((sum, slice) => sum + slice.cachedInputTokens, 0),
      requestCount: slices.reduce((sum, slice) => sum + slice.requestCount, 0),
    }),
  };
}

export function desktopMockSyncStatus(): SyncStatus {
  const rows = days();
  return {
    lastSyncAt: new Date().toISOString(),
    statsSince: rows[0]?.date ?? localDateNow(),
    sources: {},
  };
}

export function desktopMockDaily(count: number): DailyUsageResponse {
  return { days: takeDays(count).map(toDailyRow) };
}

export function desktopMockUsageDataset(input: {
  dailyDays: number;
  breakdownDays: number;
  hourlyDays: number;
}): UsageDataset {
  const daily = takeDays(input.dailyDays);
  return {
    summary: summaryFor(daily),
    syncStatus: desktopMockSyncStatus(),
    dailyRows: daily.map(toDailyRow),
    hourlyRows: hourlyRows(input.hourlyDays),
    modelRows: modelRows(input.breakdownDays),
    projectRows: projectRows(input.breakdownDays),
  };
}

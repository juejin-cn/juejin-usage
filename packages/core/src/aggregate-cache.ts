import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  aggregateDaily,
  aggregateHourly,
  aggregateModelBreakdown,
  aggregateUsageSummary,
} from './aggregate.js';
import { sealedDailyCachePath } from './paths.js';
import { normalizeProjectName } from './project-label.js';
import { roundCostUsd } from './pricing/index.js';
import {
  DEFAULT_STATS_TIMEZONE,
  addLocalDays,
  localDateAndHour,
  localDateDaysAgo,
  localDateNow,
} from './timezone.js';
import type {
  DailyUsageResponse,
  DailyUsageRow,
  HourlyUsageResponse,
  HourlyUsageRow,
  ModelBreakdownResponse,
  ModelBreakdownRow,
  ProjectBreakdownRow,
  QueueBucket,
  UsageSummary,
} from './types.js';

/** Bump when sealed project keys change (v3: encoded cwd → folder name). */
const CACHE_VERSION = 3;
/** Epoch lower bound so single-day aggregates are not clipped by statsSince. */
const EPOCH_SINCE = '1970-01-01T00:00:00.000Z';

export interface SealedModelRow {
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
}

export interface SealedProjectRow {
  project: string;
  tokens: number;
  costUsd: number;
  models: SealedModelRow[];
}

/** One closed calendar day of pre-aggregated usage. */
export interface SealedDayEntry {
  date: string;
  daily: DailyUsageRow;
  hourly: HourlyUsageRow[];
  models: SealedModelRow[];
  projects: SealedProjectRow[];
}

interface SealedCacheFile {
  version: number;
  timeZone: string;
  /** Local date when sealed days were last written (`YYYY-MM-DD`). */
  sealedAsOf: string;
  days: Record<string, SealedDayEntry>;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function emptySummary(statsSince: string): UsageSummary {
  return {
    totalTokens: 0,
    totalCostUsd: 0,
    todayTokens: 0,
    todayCostUsd: 0,
    statsSince,
    bySource: [],
  };
}

/** Collect local dates touched by buckets (for targeted reseal). */
export function touchedLocalDates(
  buckets: QueueBucket[],
  timeZone: string = DEFAULT_STATS_TIMEZONE,
): string[] {
  const dates = new Set<string>();
  for (const bucket of buckets) {
    dates.add(localDateAndHour(bucket.hour_start, timeZone).date);
  }
  return Array.from(dates).sort();
}

function buildSealedDay(
  rows: QueueBucket[],
  date: string,
  timeZone: string,
): SealedDayEntry | null {
  const bounds = { fromDate: date, toDate: date };
  const daily = aggregateDaily(rows, 1, EPOCH_SINCE, timeZone, bounds);
  const hourly = aggregateHourly(rows, 1, EPOCH_SINCE, timeZone, bounds);
  const breakdown = aggregateModelBreakdown(rows, 1, EPOCH_SINCE, timeZone, bounds);
  const dayRow = daily.days[0];
  if (!dayRow && hourly.hours.length === 0 && breakdown.models.length === 0) {
    return null;
  }
  return {
    date,
    daily: dayRow ?? {
      date,
      tokens: 0,
      costUsd: 0,
      models: {},
      projects: [],
    },
    hourly: hourly.hours,
    models: breakdown.models.map(({ model, source, tokens, costUsd }) => ({
      model,
      source,
      tokens,
      costUsd,
    })),
    projects: breakdown.projects.map((p) => ({
      project: p.project,
      tokens: p.tokens,
      costUsd: p.costUsd,
      models: p.models.map(({ model, source, tokens, costUsd }) => ({
        model,
        source,
        tokens,
        costUsd,
      })),
    })),
  };
}

function mergeModelRows(parts: SealedModelRow[]): ModelBreakdownRow[] {
  const byKey = new Map<string, SealedModelRow>();
  let totalTokens = 0;
  for (const row of parts) {
    const key = `${row.source}\0${row.model}`;
    const existing = byKey.get(key) ?? {
      model: row.model,
      source: row.source,
      tokens: 0,
      costUsd: 0,
    };
    existing.tokens += row.tokens;
    existing.costUsd += row.costUsd;
    byKey.set(key, existing);
    totalTokens += row.tokens;
  }
  return Array.from(byKey.values())
    .map((v) => ({
      model: v.model,
      source: v.source,
      tokens: v.tokens,
      costUsd: roundCostUsd(v.costUsd),
      pct: pct(v.tokens, totalTokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function mergeProjectRows(parts: SealedProjectRow[]): ProjectBreakdownRow[] {
  const byProject = new Map<
    string,
    {
      project: string;
      tokens: number;
      costUsd: number;
      models: Map<string, SealedModelRow>;
    }
  >();
  let totalTokens = 0;
  for (const row of parts) {
    const projectName = normalizeProjectName(row.project);
    const project =
      byProject.get(projectName) ??
      {
        project: projectName,
        tokens: 0,
        costUsd: 0,
        models: new Map(),
      };
    project.tokens += row.tokens;
    project.costUsd += row.costUsd;
    for (const m of row.models) {
      const key = `${m.source}\0${m.model}`;
      const existing = project.models.get(key) ?? {
        model: m.model,
        source: m.source,
        tokens: 0,
        costUsd: 0,
      };
      existing.tokens += m.tokens;
      existing.costUsd += m.costUsd;
      project.models.set(key, existing);
    }
    byProject.set(projectName, project);
    totalTokens += row.tokens;
  }
  return Array.from(byProject.values())
    .map((v) => ({
      project: v.project,
      tokens: v.tokens,
      costUsd: roundCostUsd(v.costUsd),
      pct: pct(v.tokens, totalTokens),
      models: Array.from(v.models.values())
        .map((m) => ({
          model: m.model,
          source: m.source,
          tokens: m.tokens,
          costUsd: roundCostUsd(m.costUsd),
          pct: pct(m.tokens, v.tokens),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Persist closed-day aggregates so sync / range switches only recompute today.
 * History (`date < today`) is sealed to disk; today stays live from BucketStore.
 */
export class AggregateCache {
  private days = new Map<string, SealedDayEntry>();
  private sealedAsOf: string | null = null;
  private loaded = false;
  private dirty = false;
  private readonly timeZone: string;

  constructor(
    private readonly dataDir: string,
    timeZone: string = DEFAULT_STATS_TIMEZONE,
  ) {
    this.timeZone = timeZone;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const path = sealedDailyCachePath(this.dataDir);
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as SealedCacheFile;
      if (raw.version !== CACHE_VERSION || raw.timeZone !== this.timeZone) return;
      this.sealedAsOf = raw.sealedAsOf ?? null;
      this.days = new Map(Object.entries(raw.days ?? {}));
    } catch {
      this.days.clear();
      this.sealedAsOf = null;
    }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    const path = sealedDailyCachePath(this.dataDir);
    await mkdir(dirname(path), { recursive: true });
    const payload: SealedCacheFile = {
      version: CACHE_VERSION,
      timeZone: this.timeZone,
      sealedAsOf: this.sealedAsOf ?? localDateNow(this.timeZone),
      days: Object.fromEntries(this.days.entries()),
    };
    await writeFile(path, `${JSON.stringify(payload)}\n`, 'utf8');
    this.dirty = false;
  }

  /** Drop sealed cache (e.g. after wiping queue). Next ensure will rebuild. */
  async clear(): Promise<void> {
    this.days.clear();
    this.sealedAsOf = null;
    this.dirty = true;
    this.loaded = true;
    await this.persist();
  }

  /**
   * Seal every local date strictly before today from `rows`.
   * Used on cold start when the cache file is missing or after full reload.
   */
  async rebuildFromRows(rows: QueueBucket[]): Promise<void> {
    await this.ensureLoaded();
    const today = localDateNow(this.timeZone);
    const dates = new Set<string>();
    for (const row of rows) {
      const { date } = localDateAndHour(row.hour_start, this.timeZone);
      if (date < today) dates.add(date);
    }
    this.days.clear();
    for (const date of dates) {
      const entry = buildSealedDay(rows, date, this.timeZone);
      if (entry) this.days.set(date, entry);
    }
    this.sealedAsOf = today;
    this.dirty = true;
    await this.persist();
  }

  /**
   * After BucketStore.apply / reload: reseal touched historical dates and
   * roll yesterday into sealed when the calendar day advances.
   */
  async onBucketsChanged(
    allRows: QueueBucket[],
    touchedBuckets: QueueBucket[] = [],
  ): Promise<void> {
    await this.ensureLoaded();
    const today = localDateNow(this.timeZone);

    // Cold cache or first use after upgrade: build sealed history once.
    if (this.days.size === 0 && allRows.length > 0) {
      await this.rebuildFromRows(allRows);
      return;
    }

    // Cross-midnight: seal yesterday if still missing.
    if (this.sealedAsOf && this.sealedAsOf < today) {
      const yesterday = addLocalDays(today, -1);
      if (!this.days.has(yesterday)) {
        const entry = buildSealedDay(allRows, yesterday, this.timeZone);
        if (entry) {
          this.days.set(yesterday, entry);
          this.dirty = true;
        }
      }
      this.sealedAsOf = today;
      this.dirty = true;
    } else if (!this.sealedAsOf) {
      this.sealedAsOf = today;
      this.dirty = true;
    }

    const touched = touchedLocalDates(touchedBuckets, this.timeZone);
    for (const date of touched) {
      if (date >= today) continue; // today stays live
      const entry = buildSealedDay(allRows, date, this.timeZone);
      if (entry) {
        this.days.set(date, entry);
      } else {
        this.days.delete(date);
      }
      this.dirty = true;
    }

    await this.persist();
  }

  private todayRows(rows: QueueBucket[], today: string): QueueBucket[] {
    return rows.filter(
      (row) => localDateAndHour(row.hour_start, this.timeZone).date === today,
    );
  }

  getDaily(
    rows: QueueBucket[],
    days: number,
    statsSince: string,
  ): DailyUsageResponse {
    const fromDate = localDateDaysAgo(days, this.timeZone);
    const today = localDateNow(this.timeZone);
    const statsDate =
      /^\d{4}-\d{2}-\d{2}$/.test(statsSince)
        ? statsSince
        : localDateAndHour(statsSince, this.timeZone).date;

    const out: DailyUsageRow[] = [];
    for (const [date, entry] of this.days) {
      if (date < fromDate || date > today || date < statsDate || date >= today) {
        continue;
      }
      out.push(entry.daily);
    }

    const todayAgg = aggregateDaily(
      this.todayRows(rows, today),
      1,
      EPOCH_SINCE,
      this.timeZone,
      { fromDate: today, toDate: today },
    );
    if (today >= fromDate && today >= statsDate) {
      out.push(...todayAgg.days);
    }

    out.sort((a, b) => a.date.localeCompare(b.date));
    return { days: out };
  }

  getHourly(
    rows: QueueBucket[],
    days: number,
    statsSince: string,
  ): HourlyUsageResponse {
    const fromDate = localDateDaysAgo(days, this.timeZone);
    const today = localDateNow(this.timeZone);
    const statsDate =
      /^\d{4}-\d{2}-\d{2}$/.test(statsSince)
        ? statsSince
        : localDateAndHour(statsSince, this.timeZone).date;

    const hours: HourlyUsageRow[] = [];
    for (const [date, entry] of this.days) {
      if (date < fromDate || date < statsDate || date >= today) continue;
      hours.push(...entry.hourly);
    }

    const todayAgg = aggregateHourly(
      this.todayRows(rows, today),
      1,
      EPOCH_SINCE,
      this.timeZone,
      { fromDate: today, toDate: today },
    );
    if (today >= fromDate && today >= statsDate) {
      hours.push(...todayAgg.hours);
    }

    hours.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.hour - b.hour ||
        a.source.localeCompare(b.source),
    );
    return { hours, timeZone: this.timeZone };
  }

  getModelBreakdown(
    rows: QueueBucket[],
    days: number,
    statsSince: string,
  ): ModelBreakdownResponse {
    const fromDate = localDateDaysAgo(days, this.timeZone);
    const today = localDateNow(this.timeZone);
    const statsDate =
      /^\d{4}-\d{2}-\d{2}$/.test(statsSince)
        ? statsSince
        : localDateAndHour(statsSince, this.timeZone).date;

    const modelParts: SealedModelRow[] = [];
    const projectParts: SealedProjectRow[] = [];
    for (const [date, entry] of this.days) {
      if (date < fromDate || date < statsDate || date >= today) continue;
      modelParts.push(...entry.models);
      projectParts.push(...entry.projects);
    }

    const todayBreakdown = aggregateModelBreakdown(
      this.todayRows(rows, today),
      1,
      EPOCH_SINCE,
      this.timeZone,
      { fromDate: today, toDate: today },
    );
    if (today >= fromDate && today >= statsDate) {
      for (const m of todayBreakdown.models) {
        modelParts.push({
          model: m.model,
          source: m.source,
          tokens: m.tokens,
          costUsd: m.costUsd,
        });
      }
      for (const p of todayBreakdown.projects) {
        projectParts.push({
          project: p.project,
          tokens: p.tokens,
          costUsd: p.costUsd,
          models: p.models.map(({ model, source, tokens, costUsd }) => ({
            model,
            source,
            tokens,
            costUsd,
          })),
        });
      }
    }

    return {
      models: mergeModelRows(modelParts),
      projects: mergeProjectRows(projectParts),
    };
  }

  /**
   * Summary over collect window: sealed history totals + live today.
   * Prefer this over scanning all rows when the cache is warm.
   */
  getUsageSummary(rows: QueueBucket[], statsSince: string): UsageSummary {
    const today = localDateNow(this.timeZone);
    const statsDate =
      /^\d{4}-\d{2}-\d{2}$/.test(statsSince)
        ? statsSince
        : localDateAndHour(statsSince, this.timeZone).date;

    // If cache is empty, fall back to full scan (cold start before rebuild).
    if (this.days.size === 0) {
      return aggregateUsageSummary(rows, statsSince, this.timeZone);
    }

    const bySourceMap = new Map<
      string,
      { tokens: number; costUsd: number; models: Map<string, { tokens: number; costUsd: number }> }
    >();
    let totalTokens = 0;
    let totalCostUsd = 0;

    for (const [date, entry] of this.days) {
      if (date < statsDate || date >= today) continue;
      totalTokens += entry.daily.tokens;
      totalCostUsd += entry.daily.costUsd;
      for (const m of entry.models) {
        const src =
          bySourceMap.get(m.source) ??
          {
            tokens: 0,
            costUsd: 0,
            models: new Map<string, { tokens: number; costUsd: number }>(),
          };
        src.tokens += m.tokens;
        src.costUsd += m.costUsd;
        const model = src.models.get(m.model) ?? { tokens: 0, costUsd: 0 };
        model.tokens += m.tokens;
        model.costUsd += m.costUsd;
        src.models.set(m.model, model);
        bySourceMap.set(m.source, src);
      }
    }

    const todaySummary = aggregateUsageSummary(
      this.todayRows(rows, today),
      statsSince,
      this.timeZone,
    );
    totalTokens += todaySummary.totalTokens;
    totalCostUsd += todaySummary.totalCostUsd;
    for (const src of todaySummary.bySource) {
      const existing =
        bySourceMap.get(src.source) ??
        {
          tokens: 0,
          costUsd: 0,
          models: new Map<string, { tokens: number; costUsd: number }>(),
        };
      existing.tokens += src.tokens;
      existing.costUsd += src.costUsd;
      for (const m of src.models) {
        const model = existing.models.get(m.model) ?? { tokens: 0, costUsd: 0 };
        model.tokens += m.tokens;
        model.costUsd += m.costUsd;
        existing.models.set(m.model, model);
      }
      bySourceMap.set(src.source, existing);
    }

    if (totalTokens === 0 && todaySummary.totalTokens === 0) {
      return emptySummary(statsSince);
    }

    const bySource = Array.from(bySourceMap.entries())
      .map(([source, v]) => ({
        source,
        tokens: v.tokens,
        costUsd: roundCostUsd(v.costUsd),
        pct: pct(v.tokens, totalTokens),
        models: Array.from(v.models.entries())
          .map(([model, m]) => ({
            model,
            tokens: m.tokens,
            costUsd: roundCostUsd(m.costUsd),
            pct: pct(m.tokens, v.tokens),
          }))
          .sort((a, b) => b.tokens - a.tokens),
      }))
      .sort((a, b) => b.tokens - a.tokens);

    return {
      totalTokens,
      totalCostUsd: roundCostUsd(totalCostUsd),
      todayTokens: todaySummary.todayTokens,
      todayCostUsd: todaySummary.todayCostUsd,
      statsSince,
      bySource,
    };
  }

  /** Test seam: sealed day count. */
  sealedDayCount(): number {
    return this.days.size;
  }
}

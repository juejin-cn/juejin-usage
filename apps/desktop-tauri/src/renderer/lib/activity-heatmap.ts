import { localDateNow } from './stats-timezone.ts';

export interface HeatmapCell {
  day: string;
  value: number;
  level: number;
  models: Record<string, number> | null;
}

export interface ActivityHeatmapData {
  from: string;
  to: string;
  weeks: (HeatmapCell | null)[][];
  thresholds: { t1: number; t2: number; t3: number };
}

interface DailyInput {
  date: string;
  tokens: number;
  models?: Record<string, number>;
}

function parseDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function formatDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days),
  );
}

function diffUtcDays(a: Date, b: Date): number {
  return Math.floor(
    (Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
      Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) /
      86400000,
  );
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const left = sorted[base] ?? sorted[sorted.length - 1];
  const right = sorted[Math.min(sorted.length - 1, base + 1)] ?? sorted[sorted.length - 1];
  return Math.round(left + (right - left) * rest);
}

// Level mapping uses quantile thresholds (50/75/90%).

function clampLevel(level: number): number {
  if (level <= 0) return 0;
  if (level >= 4) return 4;
  return level;
}

export function buildActivityHeatmap(
  dailyRows: DailyInput[],
  weeks = 26,
): ActivityHeatmapData {
  const endDate = parseDate(localDateNow()) ?? new Date();
  const start = addUtcDays(endDate, -(weeks * 7 - 1));

  const startDow = start.getUTCDay();
  const startAligned = addUtcDays(start, -startDow);

  const valuesByDay = new Map<
    string,
    { value: number; models: Record<string, number> | null }
  >();
  for (const row of dailyRows) {
    valuesByDay.set(row.date, {
      value: Math.max(0, row.tokens),
      models: row.models ?? null,
    });
  }

  const totalDays = diffUtcDays(startAligned, endDate) + 1;
  const weekCount = Math.ceil(totalDays / 7);

  const activeValues: number[] = [];
  for (let i = 0; i < totalDays; i++) {
    const key = formatDateUTC(addUtcDays(startAligned, i));
    const value = valuesByDay.get(key)?.value ?? 0;
    if (value > 0) activeValues.push(value);
  }
  activeValues.sort((a, b) => a - b);

  const t1 = quantile(activeValues, 0.5);
  const t2 = quantile(activeValues, 0.75);
  const t3 = quantile(activeValues, 0.9);

  function levelFor(value: number): number {
    if (!value || value <= 0) return 0;
    if (value <= t1) return 1;
    if (value <= t2) return 2;
    if (value <= t3) return 3;
    return 4;
  }

  const weeksOut: (HeatmapCell | null)[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const week: (HeatmapCell | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const dt = addUtcDays(startAligned, w * 7 + d);
      if (dt.getTime() > endDate.getTime()) {
        week.push(null);
        continue;
      }
      const day = formatDateUTC(dt);
      const dayData = valuesByDay.get(day);
      const value = dayData?.value ?? 0;
      week.push({
        day,
        value,
        level: clampLevel(levelFor(value)),
        models: dayData?.models ?? null,
      });
    }
    weeksOut.push(week);
  }

  const trimmed =
    weeksOut.length > weeks ? weeksOut.slice(weeksOut.length - weeks) : weeksOut;

  return {
    from: formatDateUTC(start),
    to: formatDateUTC(endDate),
    weeks: trimmed,
    thresholds: { t1, t2, t3 },
  };
}

export function getTimezoneLabel(): string {
  return 'UTC+08:00';
}

export function buildMonthMarkers(
  weeksCount: number,
  to: string,
  monthLabels: string[],
): Array<{ label: string; index: number }> {
  if (!weeksCount) return [];
  const end = parseDate(to) ?? new Date();
  const endWeekStart = addUtcDays(end, -end.getUTCDay());
  const startAligned = addUtcDays(endWeekStart, -(weeksCount - 1) * 7);

  const months: Date[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    months.push(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1)));
  }

  const markers: Array<{ label: string; index: number }> = [];
  const used = new Set<number>();
  for (const month of months) {
    const idx = Math.floor(diffUtcDays(startAligned, month) / 7);
    if (idx < 0 || idx >= weeksCount || used.has(idx)) continue;
    used.add(idx);
    markers.push({ label: monthLabels[month.getUTCMonth()], index: idx });
  }
  return markers;
}

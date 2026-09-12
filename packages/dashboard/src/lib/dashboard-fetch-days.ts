import { HEATMAP_LOOKBACK_DAYS } from './dashboard-mock-data.ts';
import { localDateNow } from './stats-timezone.ts';

function calendarDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return match?.[1] ?? '';
}

/** Shanghai-calendar span from the day before `date` through today. */
export function hourlyDaysForSelectedDate(
  selectedDate: string | null | undefined,
  now = new Date(),
): number {
  const date = calendarDate(selectedDate ?? '');
  if (!date) return 1;
  const today = localDateNow(undefined, now);
  const start = Date.parse(`${date}T00:00:00.000Z`);
  const end = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(2, Math.round((end - start) / 86_400_000) + 2);
}

/** Daily lookback for heatmap vs model/tool breakdown / hourly for the selected range. */
export function resolveDashboardFetchDays(
  rangeDays: number,
  selectedDate?: string | null,
  now = new Date(),
): {
  dailyDays: number;
  breakdownDays: number;
  /**
   * Hourly follows the selected range. Heatmap drill-down expands just enough
   * to include that calendar day and its comparison day.
   */
  hourlyDays: number;
} {
  return {
    dailyDays: Math.max(rangeDays, HEATMAP_LOOKBACK_DAYS),
    breakdownDays: rangeDays,
    hourlyDays: Math.max(
      rangeDays === 1 ? 2 : rangeDays,
      hourlyDaysForSelectedDate(selectedDate, now),
    ),
  };
}

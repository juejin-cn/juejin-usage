/**
 * Derive the short-lived desktop-pet celebration shown after local usage sync.
 * This module stays UI-free so milestone definitions remain easy to test.
 */

export interface PetUsageSnapshot {
  totalTokens: number;
  dailyRows: Array<{
    date: string;
    tokens: number;
  }>;
}

export interface PetSyncFeedback {
  addedTokens: number;
  isDailyRecord: boolean;
  activeStreakDays: number;
}

function tokensForDate(
  rows: PetUsageSnapshot['dailyRows'],
  date: string,
): number {
  return Math.max(0, rows.find((row) => row.date === date)?.tokens ?? 0);
}

function previousDate(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const value = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  ));
  if (Number.isNaN(value.getTime())) return null;
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/** Consecutive non-zero local-stat days ending on `today`. */
export function countActiveStreak(
  rows: PetUsageSnapshot['dailyRows'],
  today: string,
): number {
  const tokensByDate = new Map(
    rows.map((row) => [row.date, Math.max(0, row.tokens)]),
  );
  let date: string | null = today;
  let streak = 0;
  while (date && (tokensByDate.get(date) ?? 0) > 0) {
    streak += 1;
    date = previousDate(date);
  }
  return streak;
}

/**
 * A daily record is celebrated only on the sync that crosses the previous
 * all-time daily high. Later syncs on the same record day do not celebrate it
 * again, even when they add more tokens.
 */
export function buildPetSyncFeedback(
  previous: PetUsageSnapshot,
  current: PetUsageSnapshot,
  today: string,
): PetSyncFeedback | null {
  const addedTokens = Math.max(
    0,
    Math.round(current.totalTokens - previous.totalTokens),
  );
  if (addedTokens === 0) return null;

  const previousTodayTokens = tokensForDate(previous.dailyRows, today);
  const currentTodayTokens = tokensForDate(current.dailyRows, today);
  // 只有存在可比较的历史用量时，才庆祝“今日新高”。
  const hasHistory = current.dailyRows.some(
    (row) => row.date !== today && row.tokens > 0,
  );
  const previousDailyHigh = current.dailyRows.reduce(
    (highest, row) => row.date === today ? highest : Math.max(highest, row.tokens),
    0,
  );

  return {
    addedTokens,
    isDailyRecord:
      hasHistory
      && currentTodayTokens > previousDailyHigh
      && previousTodayTokens <= previousDailyHigh,
    activeStreakDays: countActiveStreak(current.dailyRows, today),
  };
}

import type { LeaderboardMetric, LeaderboardRange } from '@/lib/api';

export type RankRange = LeaderboardRange;

export const RANK_RANGES = ['today', 'week', 'month', 'all'] as const;

export function isRankRange(value: unknown): value is RankRange {
  return (
    typeof value === 'string' &&
    (RANK_RANGES as readonly string[]).includes(value)
  );
}

export interface RankModelOption {
  tool: string;
  model: string;
}

/**
 * Return the model options that can be rendered by a single Select collection.
 *
 * The API stores tool/model pairs, so a model used by more than one tool can
 * occur more than once when no tool is selected. HeroUI's ListBox is keyed by
 * the option id (the model name in RankFilter), and duplicate ids corrupt
 * React Aria's collection when the options change asynchronously.
 */
export function uniqueRankModelOptions(
  options: readonly RankModelOption[],
  tool = '',
): RankModelOption[] {
  const seen = new Set<string>();
  const result: RankModelOption[] = [];

  for (const option of options) {
    if (tool && option.tool !== tool) continue;
    if (!option.model || seen.has(option.model)) continue;
    seen.add(option.model);
    result.push(option);
  }

  return result;
}

export function formatRankPosition(rank: number | null | undefined): string {
  if (rank === null || rank === undefined || !Number.isFinite(rank) || rank < 1) {
    return '—';
  }
  return rank > 99 ? '> 99' : String(Math.floor(rank));
}

export function leaderboardMetricLabel(metric: LeaderboardMetric): string {
  return metric === 'cost' ? '按消费' : '按 Token';
}

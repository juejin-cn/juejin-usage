import { Skeleton } from '@heroui/react';
import { RankMetricSwitch } from '@/components/RankMetricSwitch';
import type { LeaderboardBoard, LeaderboardMetric } from '@/lib/api';
import { formatRankPosition, resolveLeaderboardCurrentUser } from '@/lib/leaderboard';

export function MyRankCard({
  cost,
  hideFromLeaderboard = false,
  loading,
  metric,
  onMetricChange,
  tokens,
}: {
  cost: LeaderboardBoard | null;
  hideFromLeaderboard?: boolean;
  loading: boolean;
  metric: LeaderboardMetric;
  onMetricChange: (metric: LeaderboardMetric) => void;
  tokens: LeaderboardBoard | null;
}) {
  const metrics = [
    {
      id: 'tokens' as const,
      label: '按 Token',
      rank: resolveLeaderboardCurrentUser(tokens)?.rank,
    },
    {
      id: 'cost' as const,
      label: '按消费',
      rank: resolveLeaderboardCurrentUser(cost)?.rank,
    },
  ] as const;

  const ariaLabels: Partial<Record<LeaderboardMetric, string>> = {};
  const suffixes = Object.fromEntries(metrics.map(({ id, label, rank }) => {
    const rankLabel = hideFromLeaderboard || loading ? null : formatVisibleRank(rank);
    ariaLabels[id] = rankLabel ? `${label} ${rankLabel}` : label;
    return [id, hideFromLeaderboard ? null : loading ? (
      <Skeleton aria-label={`${label}排名加载中`} className="h-3 w-6 rounded-sm" />
    ) : rankLabel ? (
      <span className="tabular-nums opacity-80">{rankLabel}</span>
    ) : null];
  }));

  return <RankMetricSwitch ariaLabels={ariaLabels} metric={metric} onMetricChange={onMetricChange} suffixes={suffixes} />;
}

/** Only render a real rank; never fall back to "—". */
function formatVisibleRank(rank: number | null | undefined): string | null {
  const formatted = formatRankPosition(rank);
  if (formatted === '—') return null;
  return `#${formatted}`;
}

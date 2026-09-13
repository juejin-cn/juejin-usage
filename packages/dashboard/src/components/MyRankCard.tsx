import { Skeleton } from '@heroui/react';
import type { LeaderboardBoard, LeaderboardMetric } from '@/lib/api';
import { formatRankPosition, resolveLeaderboardCurrentUser } from '@/lib/leaderboard';
import { cn } from '@/lib/utils';

const SEGMENT_SURFACE =
  'inline-flex h-8 max-w-full items-center rounded-full border border-white/70 bg-white/55 p-0.5 shadow-[0_1px_2px_rgb(15_60_120_/0.06)] backdrop-blur-md dark:border-white/10 dark:bg-white/[0.08] dark:shadow-none';

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

  return (
    <div
      aria-label="排行指标"
      className={SEGMENT_SURFACE}
      role="tablist"
    >
      {metrics.map(({ id, label, rank }) => {
        const selected = metric === id;
        const rankLabel =
          hideFromLeaderboard || loading ? null : formatVisibleRank(rank);
        return (
          <button
            aria-label={rankLabel ? `${label} ${rankLabel}` : label}
            aria-selected={selected}
            className={cn(
              'inline-flex h-full items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors sm:px-2.5',
              selected
                ? 'bg-white text-[#1e80ff] shadow-xs dark:bg-white/15 dark:text-[#4b9cff]'
                : 'text-muted hover:text-foreground dark:text-foreground/55 dark:hover:text-foreground/85',
            )}
            key={id}
            onClick={() => onMetricChange(id)}
            role="tab"
            type="button"
          >
            <span>{label}</span>
            {hideFromLeaderboard ? null : loading ? (
              <Skeleton
                aria-label={`${label}排名加载中`}
                className="h-3 w-6 rounded-sm"
              />
            ) : rankLabel ? (
              <span className="tabular-nums opacity-80">{rankLabel}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Only render a real rank; never fall back to "—". */
function formatVisibleRank(rank: number | null | undefined): string | null {
  const formatted = formatRankPosition(rank);
  if (formatted === '—') return null;
  return `#${formatted}`;
}

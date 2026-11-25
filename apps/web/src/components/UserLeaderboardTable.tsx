import { LeaderboardEmptyState } from './UsageEmptyState';
import { rankBadgeClass, rankNumberTone } from './leaderboard-styles';
import type {
  LeaderboardBoard,
  LeaderboardMetric,
  LeaderboardUserProfile,
} from '@/lib/api';
import { formatTokens } from '@/lib/format';
import {
  pinCurrentUserRows,
  resolveLeaderboardCurrentUser,
} from '@/lib/leaderboard';
import { formatRankUsd, resolveRankUser } from '@web/lib/rank-view';
import { cn } from '@web/lib/utils';
import { UserLeaderboardAvatar } from './UserLeaderboardAvatar';

const ROW_GRID =
  'grid grid-cols-[1.75rem_minmax(0,1fr)_4.75rem_3.75rem] items-center gap-1.5 px-3 sm:grid-cols-[3.5rem_minmax(0,1fr)_9.5rem_6.5rem] sm:gap-4 sm:px-5';

function rankAvatarRing(rank: number): string {
  if (rank === 1) return 'ring-1 ring-[#eab308]/65 dark:ring-[#f5b938]/65';
  if (rank === 2) return 'ring-1 ring-[#94a3b8]/65 dark:ring-[#cbd5e1]/50';
  if (rank === 3) return 'ring-1 ring-[#cd8a5b]/65 dark:ring-[#d69162]/60';
  return 'ring-1 ring-black/8 dark:ring-white/10';
}

export function UserLeaderboardTable({
  board,
  hideFromLeaderboard,
  metric,
  onMetricChange,
  onReload,
  profiles,
}: {
  board: LeaderboardBoard | null;
  hideFromLeaderboard: boolean;
  metric: LeaderboardMetric;
  onReload: () => void;
  onMetricChange: (metric: LeaderboardMetric) => void;
  profiles: Record<string, LeaderboardUserProfile>;
}) {
  const rows = board?.rows ?? [];
  const currentUser = hideFromLeaderboard
    ? null
    : resolveLeaderboardCurrentUser(board);
  const displayRows = pinCurrentUserRows(rows, currentUser);

  if (rows.length === 0 && !currentUser) {
    return <LeaderboardEmptyState message="当前范围暂无用户排行数据" onReload={onReload} />;
  }

  return (
    <div className="pb-5 sm:pb-6">
      <div className="overflow-clip bg-white dark:bg-surface">
        <div
          className={cn(
            ROW_GRID,
            'h-11 bg-[#fafafa] text-sm font-bold text-muted select-none dark:bg-white/[0.025]',
          )}
        >
          <span className="text-center">#</span>
          <span>用户</span>
          <button
            type="button"
            onClick={() => onMetricChange('cost')}
            className={cn(
              'ml-auto cursor-pointer text-right transition-colors hover:text-foreground',
              metric === 'cost' && 'text-primary dark:text-[#4da3ff]',
            )}
          >
            总费用
          </button>
          <button
            type="button"
            onClick={() => onMetricChange('tokens')}
            className={cn(
              'ml-auto cursor-pointer text-right transition-colors hover:text-foreground',
              metric === 'tokens' && 'text-primary dark:text-[#4da3ff]',
            )}
          >
            Token
          </button>
        </div>

        <ol className="user-rank-rows divide-y divide-black/6 dark:divide-white/8">
          {displayRows.map(({ pinned, row }) => {
            const user = resolveRankUser(row, profiles);
            const formattedCost = formatRankUsd(user.costUsd);
            const compactTokens = formatTokens(user.tokens);

            return (
              <li
                key={pinned ? `pinned-${user.userHash}` : user.userHash}
                className={cn(
                  'min-w-0 transition-colors',
                  pinned
                    ? 'sticky top-0 z-10 border-b border-primary/20 bg-[#eef6ff]/95 backdrop-blur-xs hover:bg-[#e4f1ff] dark:border-primary/25 dark:bg-[#132942]/95 dark:hover:bg-[#173352]'
                    : '[content-visibility:auto] [contain-intrinsic-size:auto_60px]',
                  !pinned && 'hover:bg-[#f7f8fa] dark:hover:bg-white/[0.03]',
                )}
              >
                <div className={cn(ROW_GRID, 'py-3 sm:py-3.5')}>
                  <span
                    aria-label={`第 ${user.rank} 名`}
                    className={cn(
                      'text-center font-code leading-none tabular-nums',
                      rankBadgeClass(user.rank),
                      user.rank > 99 ? 'text-xs sm:text-sm' : 'text-sm sm:text-[15px]',
                      pinned
                        ? 'text-primary dark:text-[#4da3ff]'
                        : rankNumberTone(user.rank),
                    )}
                  >
                    {user.rank}
                  </span>

                  <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                    <UserLeaderboardAvatar
                      lazy={!pinned && user.rank > 10}
                      name={user.displayName}
                      src={user.avatarUrl}
                      className={cn(
                        'size-8 sm:size-9',
                        pinned
                          ? 'ring-1 ring-primary/40'
                          : rankAvatarRing(user.rank),
                      )}
                      fallbackClassName="text-xs sm:text-sm"
                    />
                    <a
                      href={user.profileUrl}
                      rel="noreferrer"
                      target="_blank"
                      title={user.displayName}
                      className="min-w-0 truncate text-sm text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline sm:text-[15px]"
                    >
                      {user.displayName}
                    </a>
                    {user.isCurrentUser && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] leading-none text-primary dark:bg-primary/20 dark:text-[#66adff]">
                        我
                      </span>
                    )}
                  </div>

                  <span
                    title={formattedCost}
                    className={cn(
                      'text-right font-din text-xs whitespace-nowrap tabular-nums sm:text-[15px]',
                      metric === 'cost'
                        ? 'text-primary dark:text-[#4da3ff]'
                        : 'text-foreground/75',
                    )}
                  >
                    {formattedCost}
                  </span>

                  <span
                    title={`${user.tokens.toLocaleString('zh-CN')} Token`}
                    className={cn(
                      'text-right font-din text-xs whitespace-nowrap tabular-nums sm:text-[15px]',
                      metric === 'tokens'
                        ? 'text-primary dark:text-[#4da3ff]'
                        : 'text-foreground/75',
                    )}
                  >
                    {compactTokens}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export function UserLeaderboardTableSkeleton({ label = "用户排行榜加载中" }: { label?: string } = {}) {
  return (
    <div
      aria-label={label}
      role="status"
      className="pb-5 sm:pb-6 motion-safe:animate-pulse"
    >
      <span className="sr-only">{label}</span>
      <div className="overflow-clip bg-white dark:bg-surface">
        <div
          className={cn(
            ROW_GRID,
            'h-11 bg-[#fafafa] dark:bg-white/[0.025]',
          )}
        >
          <span className="mx-auto h-3 w-4 rounded bg-surface-secondary" />
          <span className="h-3 w-10 rounded bg-surface-secondary" />
          <span className="ml-auto h-3 w-12 rounded bg-surface-secondary" />
          <span className="ml-auto h-3 w-10 rounded bg-surface-secondary" />
        </div>
        <div className="divide-y divide-black/6 dark:divide-white/8">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className={cn(ROW_GRID, 'py-3 sm:py-3.5')}>
              <span className="mx-auto h-4 w-5 rounded bg-surface-secondary" />
              <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                <span className="size-8 shrink-0 rounded-full bg-surface-secondary sm:size-9" />
                <span className="h-4 w-28 max-w-full rounded bg-surface-secondary sm:w-36" />
              </div>
              <span className="ml-auto h-4 w-16 rounded bg-surface-secondary sm:w-20" />
              <span className="ml-auto h-4 w-12 rounded bg-surface-secondary sm:w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

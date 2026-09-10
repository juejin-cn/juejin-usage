import { useEffect, useRef, useState } from 'react';
import { Avatar, Chip, Skeleton, Switch } from '@heroui/react';
import { MyRankCard } from '@/components/MyRankCard';
import { RankTitleDecor } from '@/components/RankDecorations';
import type {
  LeaderboardBoard,
  LeaderboardMetric,
  LeaderboardOverviewResponse,
  LeaderboardRow,
  LeaderboardUserProfile,
} from '@/lib/api';
import { formatTokens, formatUsd } from '@/lib/format';
import { pinCurrentUserRows, resolveLeaderboardCurrentUser } from '@/lib/leaderboard';
import { cn } from '@/lib/utils';

type DetailedLeaderboardRow = LeaderboardRow & {
  avatarUrl?: string | null;
  uid?: string;
};

const LIST_CARD =
  'rounded-2xl border border-white/60 bg-white/90 shadow-[0_8px_30px_rgb(15_60_120_/0.06)] dark:border-white/8 dark:bg-surface dark:shadow-[0_8px_30px_rgb(0_0_0_/0.35)]';

/** Prefetch avatars slightly before they enter the viewport. */
const AVATAR_ROOT_MARGIN = '240px 0px';

export function RankUserTable({
  global,
  hideFromLeaderboard = false,
  hideToggleDisabled = false,
  loading,
  metric,
  onHideFromLeaderboardChange,
  onMetricChange,
  profiles,
  refreshing = false,
  showHideToggle = false,
}: {
  global: LeaderboardOverviewResponse['global'] | null;
  hideFromLeaderboard?: boolean;
  hideToggleDisabled?: boolean;
  loading: boolean;
  metric: LeaderboardMetric;
  onHideFromLeaderboardChange?: (hide: boolean) => void;
  onMetricChange: (metric: LeaderboardMetric) => void;
  profiles: Record<string, LeaderboardUserProfile>;
  refreshing?: boolean;
  showHideToggle?: boolean;
}) {
  const board = global?.[metric] ?? null;

  return (
    <section aria-labelledby="rank-users-title" className="space-y-3 sm:space-y-4">
      <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h2
            className="text-2xl font-bold tracking-tight sm:text-3xl"
            id="rank-users-title"
          >
            <RankTitleDecor>用户排行榜</RankTitleDecor>
          </h2>
          <MyRankCard
            cost={global?.cost ?? null}
            hideFromLeaderboard={hideFromLeaderboard}
            loading={loading}
            metric={metric}
            onMetricChange={onMetricChange}
            tokens={global?.tokens ?? null}
          />
        </div>
        {showHideToggle ? (
          <Switch
            className="shrink-0 self-start sm:self-center"
            isDisabled={hideToggleDisabled}
            isSelected={hideFromLeaderboard}
            size="sm"
            onChange={(selected) => onHideFromLeaderboardChange?.(selected)}
          >
            <Switch.Content className="gap-1.5 text-xs font-normal text-muted">
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              隐藏自己
            </Switch.Content>
          </Switch>
        ) : null}
      </div>

      {/* Skeleton only on first load; filter switches keep prior rows to avoid jump. */}
      {loading && board == null ? (
        <UserListSkeleton />
      ) : (
        <div
          className={cn(
            'transition-opacity duration-150',
            refreshing && 'pointer-events-none opacity-60',
          )}
        >
          <UserList
            board={board}
            hideFromLeaderboard={hideFromLeaderboard}
            profiles={profiles}
          />
        </div>
      )}
    </section>
  );
}

function UserList({
  board,
  hideFromLeaderboard,
  profiles,
}: {
  board: LeaderboardBoard | null;
  hideFromLeaderboard: boolean;
  profiles: Record<string, LeaderboardUserProfile>;
}) {
  const rows = board?.rows ?? [];
  const currentUser = hideFromLeaderboard
    ? null
    : resolveLeaderboardCurrentUser(board);
  const displayRows = pinCurrentUserRows(rows, currentUser);

  if (rows.length === 0 && !currentUser) {
    return (
      <div
        className={cn(
          LIST_CARD,
          'flex min-h-56 flex-col items-center justify-center gap-2 overflow-hidden text-center',
        )}
      >
        <p className="text-sm">当前范围暂无用户排行数据</p>
        <p className="text-xs text-muted">产生用量后再回来看看</p>
      </div>
    );
  }

  return (
    <div className={cn(LIST_CARD, 'min-w-0')}>
      <div
        aria-hidden
        className="flex items-center gap-2 px-4 py-2.5 text-[11px] text-muted sm:gap-5 sm:px-6 sm:py-3 sm:text-xs"
      >
        <span className="w-10 shrink-0 sm:w-12" />
        <span className="min-w-0 flex-1">用户</span>
        <div className="flex shrink-0 items-center gap-2 sm:gap-8">
          <span className="w-[3.25rem] text-right sm:w-24">总 Token</span>
          <span className="w-[3.25rem] text-right sm:w-20">总费用</span>
        </div>
      </div>
      <ol className="min-w-0">
        {displayRows.map(({ pinned, row }) => {
          const detailedRow = row as DetailedLeaderboardRow;
          const uid = detailedRow.uid ?? row.userHash;
          const profile = profiles[uid];
          const displayName = profile?.userName ?? row.displayName;
          const avatarUrl = profile?.avatarUrl ?? detailedRow.avatarUrl;
          const profileUrl =
            profile?.profileUrl ??
            `https://juejin.cn/user/${encodeURIComponent(uid)}`;
          const tokens = detailedRow.totalTokens ?? row.tokens;

          return (
            <li
              className={cn(
                'min-w-0 transition-colors',
                pinned
                  ? 'sticky top-0 z-10 border-b border-[#1e80ff]/15 bg-[#eef6ff] shadow-[0_8px_16px_rgb(15_60_120_/0.06)] hover:bg-[#e4f1ff] dark:border-[#4b9cff]/20 dark:bg-[#16324f] dark:shadow-[0_8px_16px_rgb(0_0_0_/0.25)] dark:hover:bg-[#1a3d5c]'
                  : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.04] [content-visibility:auto] [contain-intrinsic-size:auto_56px]',
              )}
              key={pinned ? `pinned-${row.userHash}` : row.userHash}
            >
              <div className="flex min-w-0 items-center gap-2 px-4 py-3 sm:gap-5 sm:px-6 sm:py-4">
                <RankNumber rank={row.rank} />

                <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
                  <LazyAvatar fallback={displayName.slice(0, 1)} src={avatarUrl} />
                  <a
                    className="min-w-0 truncate text-sm font-semibold text-foreground underline-offset-2 hover:underline sm:text-[15px]"
                    href={profileUrl}
                    rel="noreferrer"
                    target="_blank"
                    title={displayName}
                  >
                    {displayName}
                  </a>
                  {row.isCurrentUser && (
                    <Chip
                      className="shrink-0"
                      color="success"
                      size="sm"
                      variant="soft"
                    >
                      <Chip.Label>我</Chip.Label>
                    </Chip>
                  )}
                </div>

                <UsageMetrics costUsd={row.costUsd} tokens={tokens} />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Only mount avatar image after the row approaches the viewport. */
function LazyAvatar({
  fallback,
  src,
}: {
  fallback: string;
  src?: string | null;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [shouldLoad, setShouldLoad] = useState(!src);

  useEffect(() => {
    if (!src) {
      setShouldLoad(true);
      return;
    }

    const node = rootRef.current;
    if (!node) return;

    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: AVATAR_ROOT_MARGIN, threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [src]);

  return (
    <span className="inline-flex shrink-0" ref={rootRef}>
      <Avatar className="size-7 sm:size-8" size="sm">
        {shouldLoad && src ? (
          <Avatar.Image alt="" decoding="async" loading="lazy" src={src} />
        ) : null}
        <Avatar.Fallback>{fallback}</Avatar.Fallback>
      </Avatar>
    </span>
  );
}

function RankNumber({ rank }: { rank: number }) {
  return (
    <span
      aria-label={`第 ${rank} 名`}
      className={cn(
        'w-10 shrink-0 text-center font-bold tabular-nums leading-none sm:w-12',
        rank > 99 ? 'text-base sm:text-lg' : 'text-xl sm:text-2xl',
        rank === 1 && 'text-[#F53F3F] dark:text-[#ff6b6b]',
        rank === 2 && 'text-[#F77234] dark:text-[#ff9a5c]',
        rank === 3 && 'text-[#FF7D00] dark:text-[#ffb020]',
        rank > 3 && 'text-foreground/55 dark:text-foreground/45',
      )}
    >
      {rank}
    </span>
  );
}

function UsageMetrics({
  costUsd,
  tokens,
}: {
  costUsd: number;
  tokens: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 sm:gap-8">
      <span
        className="w-[3.25rem] truncate text-right text-xs font-medium tabular-nums text-foreground sm:w-24 sm:text-sm"
        title={`${tokens.toLocaleString('zh-CN')} Token`}
      >
        {formatTokens(tokens)}
      </span>
      <span
        className="w-[3.25rem] truncate text-right text-xs font-medium tabular-nums text-foreground sm:w-20 sm:text-sm"
        title={formatUsd(costUsd)}
      >
        {formatUsd(costUsd)}
      </span>
    </div>
  );
}

function UserListSkeleton() {
  return (
    <div aria-label="用户排行榜加载中" className={cn(LIST_CARD, 'min-w-0 overflow-hidden')}>
      <div className="flex items-center gap-2 px-4 py-2.5 sm:gap-5 sm:px-6 sm:py-3">
        <span className="w-10 shrink-0 sm:w-12" />
        <Skeleton className="h-3 w-8 rounded-md" />
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-8">
          <Skeleton className="h-3 w-12 rounded-md sm:w-16" />
          <Skeleton className="h-3 w-12 rounded-md sm:w-14" />
        </div>
      </div>
      {Array.from({ length: 7 }, (_, index) => (
        <div
          className="flex items-center gap-2 px-4 py-3 sm:gap-5 sm:px-6 sm:py-4"
          key={index}
        >
          <Skeleton className="h-6 w-10 shrink-0 rounded-md sm:h-7 sm:w-12" />
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
            <Skeleton className="size-7 shrink-0 rounded-full sm:size-8" />
            <Skeleton className="h-4 w-24 max-w-full rounded-md sm:w-36" />
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-8">
            <Skeleton className="h-3.5 w-12 rounded-md sm:h-4 sm:w-20" />
            <Skeleton className="h-3.5 w-12 rounded-md sm:h-4 sm:w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

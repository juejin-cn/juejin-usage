import type { ReactNode } from 'react';
import type {
  LeaderboardMetric,
  LeaderboardRow,
  LeaderboardUserProfile,
} from '@/lib/api';
import { formatTokens } from '@/lib/format';
import {
  formatRankUsd,
  getPodiumRows,
  resolveRankUser,
} from '@web/lib/rank-view';
import { cn } from '@web/lib/utils';
import { UserLeaderboardAvatar } from './UserLeaderboardAvatar';

const MEDAL_STYLES = {
  1: {
    slot: 'relative -top-2 mb-4 sm:-top-3 sm:mb-6',
    avatar:
      'size-[74px] sm:size-[92px] ring-[3px] ring-[#eab308] shadow-[0_8px_28px_rgb(234_179_8/0.24)] dark:ring-[#f5b938] dark:shadow-[0_8px_28px_rgb(245_185_56/0.22)]',
    fallback: 'text-2xl sm:text-3xl',
    badge:
      'size-6 -bottom-2.5 border-[1.5px] border-[#eab308] bg-white text-xs text-[#b7791f] shadow-xs dark:border-[#f5b938] dark:bg-[#1a1a1d] dark:text-[#f5b938]',
  },
  2: {
    slot: '',
    avatar:
      'size-[58px] sm:size-[70px] ring-[2.5px] ring-[#94a3b8] shadow-[0_6px_20px_rgb(148_163_184/0.18)] dark:ring-[#cbd5e1]/80 dark:shadow-[0_6px_20px_rgb(0_0_0/0.35)]',
    fallback: 'text-lg sm:text-xl',
    badge:
      'size-[22px] -bottom-2.5 border-[1.5px] border-[#94a3b8] bg-white text-[11px] text-[#475569] shadow-xs dark:border-[#cbd5e1]/80 dark:bg-[#1a1a1d] dark:text-[#e2e8f0]',
  },
  3: {
    slot: '',
    avatar:
      'size-[58px] sm:size-[70px] ring-[2.5px] ring-[#cd8a5b] shadow-[0_6px_20px_rgb(205_138_91/0.18)] dark:ring-[#d69162]/85 dark:shadow-[0_6px_20px_rgb(0_0_0/0.35)]',
    fallback: 'text-lg sm:text-xl',
    badge:
      'size-[22px] -bottom-2.5 border-[1.5px] border-[#cd8a5b] bg-white text-[11px] text-[#9c5a2c] shadow-xs dark:border-[#d69162] dark:bg-[#1a1a1d] dark:text-[#e6a678]',
  },
} as const;

export function UserLeaderboardPodium({
  rows,
  metric,
  profiles,
}: {
  rows: readonly LeaderboardRow[];
  metric: LeaderboardMetric;
  profiles: Record<string, LeaderboardUserProfile>;
}) {
  return <LeaderboardPodium metric={metric} entries={rows.slice(0, 3).map(row => {
    const user = resolveRankUser(row, profiles);
    return {
      ...user, id: user.userHash,
      avatar: (className: string, fallbackClassName: string) => (
        <UserLeaderboardAvatar lazy={false} name={user.displayName} src={user.avatarUrl}
          className={className} fallbackClassName={fallbackClassName} />
      ),
    };
  })} />;
}

interface PodiumEntry {
  id: string;
  displayName: string;
  profileUrl?: string;
  isCurrentUser?: boolean;
  costUsd: number;
  tokens: number;
  rank: number;
  avatar: (className: string, fallbackClassName: string) => ReactNode;
}

export function LeaderboardPodium({ entries, metric }: { entries: PodiumEntry[]; metric: LeaderboardMetric }) {
  const podiumRows = getPodiumRows(entries);
  if (podiumRows.length === 0) return null;

  return (
    <div
      aria-label="前三名领奖台"
      className="relative overflow-hidden px-3 pt-6 pb-5 sm:px-6 sm:pt-9 sm:pb-7"
    >
      <div className="mx-auto flex max-w-2xl items-end justify-center gap-2 sm:gap-10 md:gap-14">
        {podiumRows.map((entry) => {
          const Slot = entry.profileUrl ? 'a' : 'div';
          const medalKey = (
            entry.rank === 1 || entry.rank === 2 || entry.rank === 3 ? entry.rank : 3
          ) as 1 | 2 | 3;
          const style = MEDAL_STYLES[medalKey];
          const compactTokens = formatTokens(entry.tokens);
          const formattedCost = formatRankUsd(entry.costUsd);

          return (
            <Slot
              key={entry.id}
              data-podium-rank={entry.rank}
              {...(entry.profileUrl && { href: entry.profileUrl, rel: "noreferrer", target: "_blank" })}
              className={cn(
                'group flex min-w-0 basis-0 flex-1 max-w-[168px] flex-col items-center text-center outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl py-1',
                style.slot,
              )}
            >
              <div className="relative inline-flex shrink-0 motion-safe:transition-transform motion-safe:duration-200 group-hover:-translate-y-0.5">
                {entry.avatar(style.avatar, style.fallback)}
                <span
                  aria-label={`第 ${entry.rank} 名`}
                  className={cn(
                    'absolute left-1/2 -translate-x-1/2 grid place-items-center rounded-full font-code leading-none tabular-nums',
                    style.badge,
                  )}
                >
                  {entry.rank}
                </span>
              </div>

              <div className="mt-4 flex max-w-full items-center justify-center gap-1">
                <span
                  className="truncate text-sm/5 font-medium text-foreground transition-colors group-hover:text-primary sm:text-base/6"
                  title={entry.displayName}
                >
                  {entry.displayName}
                </span>
                {entry.isCurrentUser && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary dark:bg-primary/20 dark:text-[#66adff]">
                    我
                  </span>
                )}
              </div>

              {metric === 'tokens' ? (
                <div
                  className="mt-1 inline-flex items-baseline justify-center gap-1 whitespace-nowrap"
                  title={`${entry.tokens.toLocaleString('zh-CN')} Token`}
                >
                  <span
                    className="font-din text-base/6 font-bold text-primary tabular-nums sm:text-lg/6"
                  >
                    {compactTokens}
                  </span>
                  <span className="font-din text-sm text-muted">Token</span>
                </div>
              ) : (
                <div
                  className="mt-1 whitespace-nowrap"
                  title={formattedCost}
                >
                  <span
                    className="font-din text-base/6 font-bold text-primary tabular-nums sm:text-lg/6"
                  >
                    {formattedCost}
                  </span>
                </div>
              )}

              <div className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full bg-black/[0.03] px-2 py-0.5 text-xs/5 text-muted tabular-nums sm:gap-1.5 sm:px-2.5 sm:text-sm/5 dark:bg-white/[0.045]">
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-3 shrink-0 rounded-full border-[3px] bg-clip-padding sm:size-4 sm:border-4',
                    medalKey === 1 && 'border-[#ffed99] bg-[#f2ad00] dark:border-amber-400/30',
                    medalKey === 2 && 'border-[#dcfce7] bg-[#00c853] dark:border-green-400/30',
                    medalKey === 3 && 'border-[#e0e7ff] bg-[#635bff] dark:border-indigo-400/30',
                  )}
                />
                <span className="truncate font-din font-bold">
                  {metric === 'tokens' ? formattedCost : `${compactTokens} Token`}
                </span>
              </div>
            </Slot>
          );
        })}
      </div>
    </div>
  );
}

export function UserLeaderboardPodiumSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="px-3 pt-6 pb-5 sm:px-6 sm:pt-9 sm:pb-7 motion-safe:animate-pulse"
    >
      <div className="mx-auto flex max-w-2xl items-end justify-center gap-2 sm:gap-10 md:gap-14">
        {[
          { avatar: 'size-[58px] sm:size-[70px]', offset: '' },
          { avatar: 'size-[74px] sm:size-[92px]', offset: MEDAL_STYLES[1].slot },
          { avatar: 'size-[58px] sm:size-[70px]', offset: '' },
        ].map((slot, index) => (
          <div
            key={index}
            className={cn(
              'flex min-w-0 basis-0 flex-1 max-w-[168px] flex-col items-center py-1',
              slot.offset,
            )}
          >
            <div className={cn('rounded-full bg-surface-secondary', slot.avatar)} />
            <div className="mt-4 h-5 sm:h-6 w-20 rounded bg-surface-secondary" />
            <div className="mt-1 h-6 w-16 rounded bg-surface-secondary" />
            <div className="mt-1.5 h-6 w-14 rounded-full bg-surface-secondary" />
          </div>
        ))}
      </div>
    </div>
  );
}

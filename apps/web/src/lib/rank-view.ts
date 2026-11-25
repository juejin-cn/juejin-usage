import type { LeaderboardRow, LeaderboardUserProfile } from '@/lib/api';
import { formatRankPosition } from '@/lib/leaderboard';

export type DetailedLeaderboardRow = LeaderboardRow & {
  avatarUrl?: string | null;
  uid?: string;
};

export interface ResolvedRankUser {
  uid: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  tokens: number;
  costUsd: number;
  rank: number;
  isCurrentUser: boolean;
  userHash: string;
}

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatRankUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  return `$${USD_FORMATTER.format(value)}`;
}

export function formatRankBadge(rank: number | null | undefined): string | null {
  const formatted = formatRankPosition(rank);
  if (formatted === '—') return null;
  return `#${formatted}`;
}

export function resolveRankUser(
  row: LeaderboardRow,
  profiles: Record<string, LeaderboardUserProfile>,
): ResolvedRankUser {
  const detailed = row as DetailedLeaderboardRow;
  const uid = detailed.uid ?? row.userHash;
  const profile = profiles[uid];

  return {
    uid,
    displayName: profile?.userName ?? row.displayName,
    avatarUrl: profile?.avatarUrl ?? detailed.avatarUrl ?? null,
    profileUrl:
      profile?.profileUrl ??
      `https://juejin.cn/user/${encodeURIComponent(uid)}`,
    tokens: detailed.totalTokens ?? row.tokens,
    costUsd: row.costUsd,
    rank: row.rank,
    isCurrentUser: row.isCurrentUser,
    userHash: row.userHash,
  };
}

/** Order top 3 rows into visual podium slots: [#2, #1, #3]. */
export function getPodiumRows<T>(rows: readonly T[]): T[] {
  const top = rows.slice(0, 3);
  if (top.length < 2) return top;
  if (top.length === 2) return [top[1]!, top[0]!];
  return [top[1]!, top[0]!, top[2]!];
}

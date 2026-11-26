import type { RankRange } from '@/lib/leaderboard';

export const RANGE_OPTIONS: readonly { id: RankRange; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'month', label: '本月' },
  { id: 'all', label: '全部' },
];

export const leaderboardSurface = '@container web-leaderboard-surface';

export function rankNumberTone(rank: number): string {
  if (rank === 1) return 'text-[#d4920a] dark:text-[#f5b938]';
  if (rank === 2) return 'text-[#64748b] dark:text-[#cbd5e1]';
  if (rank === 3) return 'text-[#bd6e39] dark:text-[#e09866]';
  return 'text-muted';
}

const medalBackgrounds: Partial<Record<number, string>> = {
  1: 'bg-amber-500/15 dark:bg-amber-400/20',
  2: 'bg-slate-400/15 dark:bg-slate-300/20',
  3: 'bg-orange-600/10 dark:bg-orange-400/20',
};

export function rankBadgeClass(rank: number) {
  const background = medalBackgrounds[rank];
  return background && `grid size-7 place-items-center justify-self-center rounded-full ${background}`;
}

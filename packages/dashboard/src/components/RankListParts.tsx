import { formatTokens, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

export const RANK_LIST_CARD =
  'rounded-2xl border border-white/60 bg-white/90 shadow-[0_8px_30px_rgb(15_60_120_/0.06)] dark:border-white/8 dark:bg-surface dark:shadow-[0_8px_30px_rgb(0_0_0_/0.35)]';

export function RankNumber({ rank }: { rank: number }) {
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

export function RankUsageMetrics({
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

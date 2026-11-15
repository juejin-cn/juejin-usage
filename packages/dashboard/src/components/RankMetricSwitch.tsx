import type { ReactNode } from 'react';
import type { LeaderboardMetric } from '@/lib/api';
import { cn } from '@/lib/utils';

export function RankMetricSwitch({
  ariaLabels,
  costLabel = '按消费',
  metric,
  onMetricChange,
  suffixes,
}: {
  ariaLabels?: Partial<Record<LeaderboardMetric, string>>;
  costLabel?: string;
  metric: LeaderboardMetric;
  onMetricChange: (metric: LeaderboardMetric) => void;
  suffixes?: Partial<Record<LeaderboardMetric, ReactNode>>;
}) {
  const metrics: readonly { id: LeaderboardMetric; label: string }[] = [
    { id: 'tokens', label: '按 Token' },
    { id: 'cost', label: costLabel },
  ];
  return (
    <div
      aria-label="排行指标"
      className="inline-flex h-8 max-w-full items-center rounded-full border border-white/70 bg-white/55 p-0.5 shadow-[0_1px_2px_rgb(15_60_120_/0.06)] backdrop-blur-md dark:border-white/10 dark:bg-white/[0.08] dark:shadow-none"
      role="tablist"
    >
      {metrics.map(({ id, label }) => (
        <button
          aria-label={ariaLabels?.[id] ?? label}
          aria-selected={metric === id}
          className={cn(
            'inline-flex h-full cursor-pointer items-center gap-1 rounded-full px-2 text-xs font-medium transition-colors sm:px-2.5',
            metric === id
              ? 'bg-white text-[#1e80ff] shadow-xs dark:bg-white/15 dark:text-[#4b9cff]'
              : 'text-muted hover:text-foreground dark:text-foreground/55 dark:hover:text-foreground/85',
          )}
          key={id}
          onClick={() => onMetricChange(id)}
          role="tab"
          type="button"
        >
          <span>{label}</span>
          {suffixes?.[id]}
        </button>
      ))}
    </div>
  );
}

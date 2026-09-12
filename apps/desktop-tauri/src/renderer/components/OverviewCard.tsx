import { useMemo } from 'react';
import { Card } from '@heroui/react';
import { ActivityHeatmap } from '@/components/ActivityHeatmap';
import type {
  DailyUsageRow,
  ModelBreakdownRow,
  UsageSummary,
} from '@/lib/api';
import { formatTokens, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

interface OverviewCardProps {
  summary: UsageSummary;
  dailyRows: DailyUsageRow[];
  modelRows?: ModelBreakdownRow[];
}

/** BoardUI-style overview: hero metric + nested stats + full-width heatmap. */
export function OverviewCard({
  summary,
  dailyRows,
  modelRows = [],
}: OverviewCardProps) {
  const activeDays = useMemo(
    () => dailyRows.filter((d) => d.tokens > 0).length,
    [dailyRows],
  );

  const nested = [
    { label: '估算费用', value: formatUsd(summary.totalCostUsd) },
    { label: '今日 Token', value: formatTokens(summary.todayTokens) },
    { label: '今日费用', value: formatUsd(summary.todayCostUsd) },
    { label: '活跃天数', value: String(activeDays) },
  ];

  return (
    <Card className="w-full overflow-hidden rounded-[16px]">
      <Card.Header className="gap-4 pb-0">
        <Card.Title className="text-sm font-medium text-muted">
          概览
        </Card.Title>

        <div>
          <div className="text-sm font-medium text-muted">总 Token</div>
          <div className="mt-1 text-[2rem] font-medium leading-[2.75rem] tracking-normal text-foreground sm:text-[2.5rem] sm:leading-[3.375rem]">
            {formatTokens(summary.totalTokens)}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {nested.map((item) => (
            <div
              key={item.label}
              className={cn(
                'rounded-[10px] border border-border bg-surface px-3 py-2.5 shadow-[var(--shadow-card)]',
              )}
            >
              <div className="text-base font-medium leading-6 tracking-normal text-foreground sm:text-lg">
                {item.value}
              </div>
              <div className="mt-0.5 text-xs font-medium text-muted">
                {item.label}
              </div>
            </div>
          ))}
        </div>
      </Card.Header>

      <Card.Content className="pt-5">
        <ActivityHeatmap days={dailyRows} models={modelRows} embedded />
      </Card.Content>
    </Card>
  );
}

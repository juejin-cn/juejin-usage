import { memo, useId, useMemo } from 'react';
import { Card, Chip } from '@heroui/react';
import { ActivityHeatmap } from '@/components/ActivityHeatmap';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import type { DailyUsageRow, ModelBreakdownRow } from '@/lib/api';
import type {
  DashboardDailyUsageRow,
  DashboardMetricTrend,
  DashboardMetricTrends,
  DashboardUsageSummary,
} from '@/lib/dashboard-mock-data';
import {
  formatTokens,
  formatTokensExact,
  formatUsd,
} from '@/lib/format';

interface DashboardOverviewCardProps {
  /** Fixed recent 7 calendar days for the overview sparklines. */
  dailyUsage: DashboardDailyUsageRow[];
  heatmapDays: DailyUsageRow[];
  modelRows?: ModelBreakdownRow[];
  metricTrends: DashboardMetricTrends;
  summary: DashboardUsageSummary;
  selectedDate?: string | null;
  onSelectDate?: (date: string) => void;
}

/** Four inline metrics and the daily heatmap, styled to match the tray overview. */
export const DashboardOverviewCard = memo(function DashboardOverviewCard({
  dailyUsage,
  heatmapDays,
  modelRows = [],
  metricTrends,
  summary,
  selectedDate = null,
  onSelectDate,
}: DashboardOverviewCardProps) {
  const metrics = [
    {
      label: '预估费用',
      value: summary.totalCostUsd,
      format: formatUsd,
      exactFormat: formatUsd,
      trend: {
        comparison: metricTrends.totalCostUsd,
        display: 'percent' as const,
        values: dailyUsage.map((row) => row.costUsd),
      },
    },
    {
      label: '总 Token',
      value: summary.totalTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      trend: {
        comparison: metricTrends.totalTokens,
        display: 'percent' as const,
        values: dailyUsage.map((row) => row.totalTokens),
      },
    },
    {
      label: '输入 Token',
      value: summary.inputTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      trend: {
        comparison: metricTrends.inputTokens,
        display: 'tokens' as const,
        values: dailyUsage.map((row) => row.inputTokens),
      },
    },
    {
      label: '输出 Token',
      value: summary.outputTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      trend: {
        comparison: metricTrends.outputTokens,
        display: 'tokens' as const,
        values: dailyUsage.map((row) => row.outputTokens),
      },
    },
  ] as const;

  return (
    <section aria-label="用量概览" className="w-full">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <Card
            className="h-[5.5rem] min-h-[5.5rem] min-w-0 overflow-hidden rounded-2xl p-3"
            key={metric.label}
          >
            <Card.Content className="grid h-full grid-rows-[1.25rem_1fr] content-start gap-3 p-0">
              <div className="flex h-5 min-w-0 items-center justify-between gap-2">
                <p className="min-w-0 truncate text-xs font-medium leading-5 text-muted">
                  {metric.label}
                </p>
                <div className="flex h-5 shrink-0 items-center justify-end">
                  {metric.trend.comparison ? (
                    <MetricTrend
                      display={metric.trend.display}
                      trend={metric.trend.comparison}
                    />
                  ) : null}
                </div>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_64px] items-end gap-2">
                <NestedAnimatedValue
                  exactFormat={metric.exactFormat}
                  format={metric.format}
                  label={metric.label}
                  value={metric.value}
                />
                <MetricSparkline
                  isIncrease={(metric.trend.comparison?.changeValue ?? 0) >= 0}
                  label={`近 7 日${metric.label}趋势`}
                  values={metric.trend.values}
                />
              </div>
            </Card.Content>
          </Card>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-border/60 bg-surface p-4 sm:p-5">
        <HeatmapSection
          days={heatmapDays}
          modelRows={modelRows}
          onSelectDate={onSelectDate}
          selectedDate={selectedDate}
        />
      </div>
    </section>
  );
});

function HeatmapSection({
  days,
  modelRows,
  selectedDate,
  onSelectDate,
}: {
  days: DailyUsageRow[];
  modelRows: ModelBreakdownRow[];
  selectedDate: string | null;
  onSelectDate?: (date: string) => void;
}) {
  return (
    <ActivityHeatmap
      days={days}
      embedded
      models={modelRows}
      onSelectDate={onSelectDate}
      selectedDate={selectedDate}
    />
  );
}

function NestedAnimatedValue({
  exactFormat,
  format,
  label,
  value,
}: {
  exactFormat: (value: number) => string;
  format: (value: number) => string;
  label: string;
  value: number;
}) {
  const animatedValue = useAnimatedNumber(value);

  return (
    <div
      aria-label={`${label} ${exactFormat(value)}`}
      className="min-w-0 truncate text-lg font-semibold leading-7 tracking-tight text-foreground tabular-nums"
      title={exactFormat(value)}
    >
      {format(animatedValue)}
    </div>
  );
}

function MetricSparkline({
  label,
  values,
  isIncrease,
}: {
  label: string;
  values: readonly number[];
  isIncrease: boolean;
}) {
  const gradientId = useId().replace(/:/g, '');
  const points = useMemo(
    () => values.filter((value) => Number.isFinite(value)),
    [values],
  );

  if (points.length < 2) {
    return (
      <div
        aria-hidden="true"
        className="h-6 w-16 justify-self-end"
      />
    );
  }

  const width = 64;
  const height = 24;
  const padding = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stroke = isIncrease ? 'var(--chart-2)' : 'var(--chart-5)';
  const path = points
    .map((value, index) => {
      const x =
        padding +
        (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
      const y =
        height -
        padding -
        ((value - min) / span) * (height - padding * 2);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div aria-label={label} className="pointer-events-none h-6 w-16 justify-self-end" role="img">
      <svg
        aria-hidden="true"
        className="h-full w-full overflow-visible"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.24} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path
          d={`${path} L ${width - padding} ${height} L ${padding} ${height} Z`}
          fill={`url(#${gradientId})`}
        />
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

function MetricTrend({
  display,
  trend,
}: {
  display: 'percent' | 'tokens';
  trend: DashboardMetricTrend;
}) {
  const isIncrease = trend.changeValue >= 0;
  const direction = isIncrease ? '上涨' : '下降';
  const label =
    display === 'tokens'
      ? `${isIncrease ? '+' : '−'}${formatTokens(Math.abs(trend.changeValue))}`
      : `${Math.abs(trend.changePct).toFixed(1)}%`;

  return (
    <Chip
      aria-label={`${direction} ${label}`}
      className="shrink-0"
      color={isIncrease ? 'success' : 'danger'}
      size="sm"
      variant="soft"
    >
      <span aria-hidden="true">{isIncrease ? '↑' : '↓'}</span>
      <Chip.Label className="tabular-nums">{label}</Chip.Label>
    </Chip>
  );
}

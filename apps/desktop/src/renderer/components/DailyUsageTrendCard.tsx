import { memo, useId, useMemo, useState } from 'react';
import { Card } from '@heroui/react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CHART_TOOLTIP_SURFACE_CLASSNAME,
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from '@/components/ChartPrimitives';
import { DashboardMetricTabs } from '@/components/DashboardMetricTabs';
import type {
  DashboardDailyUsageRow,
  DashboardHourlyUsageRow,
} from '@/lib/dashboard-mock-data';
import { formatDashboardMetricCompact } from '@/lib/dashboard-metric-format';
import { formatTokens, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

const METRICS = ['tokens', 'cost'] as const;
type TrendMetric = (typeof METRICS)[number];

const CHART_CONFIG = {
  inputTokens: {
    label: '输入',
    color: 'var(--chart-1)',
  },
  cachedInputTokens: {
    label: '缓存输入',
    color: 'var(--chart-3)',
  },
  outputTokens: {
    label: '输出',
    color: 'var(--chart-2)',
  },
  otherTokens: {
    label: '其他',
    color: 'var(--chart-6)',
  },
  totalTokens: {
    label: '总 Token',
    color: 'var(--chart-4)',
  },
  costUsd: {
    label: '费用',
    color: 'var(--chart-5)',
  },
} satisfies ChartConfig;

export const DailyUsageTrendCard = memo(function DailyUsageTrendCard({
  className = '',
  hourly = false,
  hourlyRows = [],
  rows,
  dayScoped = false,
  rangeDays = 7,
}: {
  className?: string;
  hourly?: boolean;
  hourlyRows?: DashboardHourlyUsageRow[];
  rows: DashboardDailyUsageRow[];
  /** Heatmap day filter — use 「当日」 copy instead of 「今日」. */
  dayScoped?: boolean;
  /** Selected multi-day window; ignored in hourly / today mode. */
  rangeDays?: number;
}) {
  const gradientId = useId().replace(/:/g, '');
  const [metric, setMetric] = useState<TrendMetric>('tokens');

  const chartRows = useMemo(() => {
    if (hourly) {
      return [...hourlyRows]
        .sort((a, b) => a.hour - b.hour)
        .map((row) => {
          const uncached = Math.max(0, row.inputTokens - row.cachedInputTokens);
          return buildStackedRow({
            dateLabel: `${row.hour}h`,
            outputTokens: row.outputTokens,
            uncachedInputTokens: uncached,
            cachedInputTokens: row.cachedInputTokens,
            totalTokens: row.totalTokens,
            costUsd: row.costUsd,
          });
        });
    }

    return rows.map((row) =>
      buildStackedRow({
        dateLabel: row.dateLabel,
        outputTokens: row.outputTokens,
        uncachedInputTokens: row.uncachedInputTokens,
        cachedInputTokens: row.cachedInputTokens,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
      }),
    );
  }, [hourly, hourlyRows, rows]);
  const xAxisInterval = hourly
    ? 2
    : Math.max(0, Math.ceil(chartRows.length / 8) - 1);

  const title = hourly
    ? dayScoped
      ? '当日趋势'
      : '今日趋势'
    : '每日趋势';
  const description = hourly
    ? dayScoped
      ? '当日按小时的 Token 与费用趋势'
      : '今日按小时的 Token 与费用趋势'
    : `最近 ${rangeDays} 天的 Token 与费用趋势`;

  return (
    <Card className={`h-full min-w-0 overflow-hidden rounded-2xl ${className}`}>
      <Card.Header className="flex-row flex-nowrap items-start justify-between gap-3 pb-0">
        <div className="min-w-0 flex-1">
          <Card.Title>{title}</Card.Title>
          <Card.Description className="mt-1">
            {description}
          </Card.Description>
        </div>
        <DashboardMetricTabs
          ariaLabel={hourly ? '今日趋势指标' : '每日趋势指标'}
          metrics={METRICS}
          selectedMetric={metric}
          onMetricChange={setMetric}
        />
      </Card.Header>

      <Card.Content className="pt-3">
        {chartRows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">
            暂无数据
          </p>
        ) : (
          <ChartContainer
            className="h-[260px] w-full"
            config={CHART_CONFIG}
            initialDimension={{ width: 720, height: 260 }}
          >
            <ComposedChart
              accessibilityLayer
              data={chartRows}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id={`${gradientId}-cost`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-costUsd)" stopOpacity={0.48} />
                  <stop offset="68%" stopColor="var(--color-costUsd)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--color-costUsd)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="dateLabel"
                interval={xAxisInterval}
                minTickGap={16}
                tick={{ fontSize: 11 }}
                tickLine={false}
                tickMargin={10}
              />
              {metric === 'tokens' ? (
                <YAxis
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    formatDashboardMetricCompact('tokens', value)
                  }
                  tickLine={false}
                  tickMargin={8}
                  width={52}
                />
              ) : (
                <YAxis
                  axisLine={false}
                  tickFormatter={(value: number) => formatUsd(value)}
                  tickLine={false}
                  tickMargin={8}
                  width="auto"
                />
              )}
              <ChartTooltip
                content={<DailyTrendTooltip metric={metric} />}
                cursor={{ fill: 'var(--surface-secondary)' }}
              />
              {metric === 'tokens' ? (
                <>
                  <Bar
                    dataKey="inputTokens"
                    fill="var(--color-inputTokens)"
                    isAnimationActive={false}
                    maxBarSize={hourly ? 20 : 32}
                    stackId="tokens"
                  />
                  <Bar
                    dataKey="cachedInputTokens"
                    fill="var(--color-cachedInputTokens)"
                    isAnimationActive={false}
                    maxBarSize={hourly ? 20 : 32}
                    stackId="tokens"
                  />
                  <Bar
                    dataKey="outputTokens"
                    fill="var(--color-outputTokens)"
                    isAnimationActive={false}
                    maxBarSize={hourly ? 20 : 32}
                    radius={[4, 4, 0, 0]}
                    stackId="tokens"
                  />
                  <Bar
                    dataKey="otherTokens"
                    fill="var(--color-otherTokens)"
                    isAnimationActive={false}
                    maxBarSize={hourly ? 20 : 32}
                    radius={[4, 4, 0, 0]}
                    stackId="tokens"
                  />
                </>
              ) : (
                <>
                  <Area
                    dataKey="costUsd"
                    fill={`url(#${gradientId}-cost)`}
                    fillOpacity={1}
                    isAnimationActive={false}
                    stroke="none"
                    type="monotone"
                  />
                  <Line
                    dataKey="costUsd"
                    dot={false}
                    isAnimationActive={false}
                    stroke="var(--color-costUsd)"
                    strokeLinecap="round"
                    strokeWidth={2}
                    type="monotone"
                  />
                </>
              )}
            </ComposedChart>
          </ChartContainer>
        )}
      </Card.Content>
    </Card>
  );
});

function buildStackedRow({
  cachedInputTokens,
  costUsd,
  dateLabel,
  outputTokens,
  totalTokens,
  uncachedInputTokens,
}: {
  cachedInputTokens: number;
  costUsd: number;
  dateLabel: string;
  outputTokens: number;
  totalTokens: number;
  uncachedInputTokens: number;
}) {
  return {
    dateLabel,
    totalTokens,
    costUsd,
    inputTokens: uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
    otherTokens: Math.max(
      0,
      totalTokens - uncachedInputTokens - cachedInputTokens - outputTokens,
    ),
  };
}

interface DailyTrendPoint {
  dateLabel: string;
  totalTokens: number;
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  otherTokens: number;
}

function DailyTrendTooltip({
  active,
  metric,
  payload,
}: {
  active?: boolean;
  metric: TrendMetric;
  payload?: Array<{ payload?: DailyTrendPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div
      className={cn(
        'grid min-w-48 gap-2 px-3 py-2.5 text-xs',
        CHART_TOOLTIP_SURFACE_CLASSNAME,
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-overlay-foreground">
          {point.dateLabel}
        </span>
        <span className="font-semibold text-overlay-foreground tabular-nums">
          {metric === 'tokens'
            ? formatTokens(point.totalTokens)
            : formatUsd(point.costUsd)}
        </span>
      </div>
      {metric === 'tokens' ? (
        <div className="grid gap-1.5 text-muted">
          <DailyTooltipRow
            color="var(--chart-1)"
            label="输入"
            value={formatTokens(point.inputTokens)}
          />
          <DailyTooltipRow
            color="var(--chart-3)"
            label="缓存输入"
            value={formatTokens(point.cachedInputTokens)}
          />
          <DailyTooltipRow
            color="var(--chart-2)"
            label="输出"
            value={formatTokens(point.outputTokens)}
          />
          {point.otherTokens > 0 ? (
            <DailyTooltipRow
              color="var(--chart-6)"
              label="其他"
              value={formatTokens(point.otherTokens)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DailyTooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 tabular-nums">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        {label}
      </span>
      <span className="font-medium text-overlay-foreground">{value}</span>
    </div>
  );
}

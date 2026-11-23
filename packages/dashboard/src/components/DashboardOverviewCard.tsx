import { MetricSparkline } from './MetricSparkline';
import { TokenBreakdownPanel } from './TokenBreakdownPanel';
import { AnimatedNumber } from './AnimatedNumber';
import { useMemo, useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { Card } from '@/components/UsageCard';
import { Button, Chip, Popover, Tooltip } from '@heroui/react';
import { ActivityHeatmap } from '@/components/ActivityHeatmap';
import {
  buildUsageMetricTrendValues,
  type UsageMetricTrendPoint,
} from '@juejin-opensource/jusage-core/dashboard-trend';
import type { DailyUsageRow, ModelBreakdownRow } from '@/lib/api';
import type {
  DashboardMetricTrend,
  DashboardMetricTrends,
  DashboardUsageSummary,
} from '@/lib/dashboard-mock-data';
import {
  formatTokens,
  formatTokensExact,
  formatUsd,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { getTauriDesktopBridge } from '@/lib/tauri-desktop';

interface DashboardOverviewCardProps {
  /** Ordered hourly or daily buckets for the selected dashboard range. */
  metricTrendRows: readonly UsageMetricTrendPoint[];
  metricTrendPeriodLabel: string;
  heatmapDays: DailyUsageRow[];
  modelRows?: ModelBreakdownRow[];
  metricTrends: DashboardMetricTrends;
  summary: DashboardUsageSummary;
  selectedDate?: string | null;
  onSelectDate?: (date: string) => void;
  /** Local CLI/Desktop only: show request count + cache hit captions. */
  showLocalMetrics?: boolean;
  /** Subscription cards between overview metrics and heatmap. */
  belowMetrics?: ReactNode;
}

/** Four inline metrics and the daily heatmap, styled to match the tray overview. */
export function DashboardOverviewCard({
  metricTrendRows,
  metricTrendPeriodLabel,
  heatmapDays,
  modelRows = [],
  metricTrends,
  summary,
  selectedDate = null,
  onSelectDate,
  showLocalMetrics = false,
  belowMetrics,
}: DashboardOverviewCardProps) {
  const tauriDesktop = Boolean(getTauriDesktopBridge());
  const metricTrendValues = useMemo(
    () => buildUsageMetricTrendValues(metricTrendRows),
    [metricTrendRows],
  );
  const requestCaption = showLocalMetrics
    ? formatRequestCaption(summary)
    : null;
  const cacheHitRate = showLocalMetrics
    ? cacheHitRateFromSummary(summary)
    : null;
  const reserveCaption = showLocalMetrics;
  const metrics = [
    {
      id: 'cost',
      label: '预估费用',
      value: summary.totalCostUsd,
      format: formatUsd,
      exactFormat: formatUsd,
      caption: null as string | null,
      trend: {
        comparison: metricTrends.totalCostUsd,
        display: 'percent' as const,
        values: metricTrendValues.costUsd,
      },
    },
    {
      id: 'total-tokens',
      label: '总 Token',
      value: summary.totalTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      caption: requestCaption,
      trend: {
        comparison: metricTrends.totalTokens,
        display: 'percent' as const,
        values: metricTrendValues.totalTokens,
      },
    },
    {
      id: 'input-tokens',
      label: '输入 Token',
      value: summary.inputTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      caption:
        cacheHitRate == null
          ? null
          : `缓存命中率 ${(cacheHitRate * 100).toFixed(1)}%`,
      trend: {
        comparison: metricTrends.inputTokens,
        display: 'tokens' as const,
        values: metricTrendValues.inputTokens,
      },
    },
    {
      id: 'output-tokens',
      label: '输出 Token',
      value: summary.outputTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      caption: null as string | null,
      trend: {
        comparison: metricTrends.outputTokens,
        display: 'tokens' as const,
        values: metricTrendValues.outputTokens,
      },
    },
  ] as const;

  return (
    <section aria-label="用量概览" className="w-full">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <Card
            className={cn(
              'min-w-0 overflow-hidden rounded-2xl p-3',
              reserveCaption
                ? 'h-[6.25rem] min-h-[6.25rem]'
                : 'h-[5.5rem] min-h-[5.5rem]',
            )}
            key={metric.id}
          >
            <Card.Content className="grid h-full grid-rows-[1.25rem_1fr] content-start gap-3 p-0">
              <div className="flex h-5 min-w-0 items-center justify-between gap-2">
                {metric.id === 'total-tokens' ? (
                  <TotalTokenLabel
                    showRequestHelp={showLocalMetrics}
                    summary={summary}
                  />
                ) : metric.id === 'input-tokens' && showLocalMetrics ? (
                  <InputTokenLabel />
                ) : (
                  <p className="min-w-0 truncate text-xs font-medium leading-5 text-muted">
                    {metric.label}
                  </p>
                )}
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
                <div className="min-w-0">
                  <NestedAnimatedValue
                    exactFormat={metric.exactFormat}
                    format={metric.format}
                    label={metric.label}
                    value={metric.value}
                  />
                  {reserveCaption ? (
                    <p className="mt-0.5 h-4 truncate text-[10px] leading-4 text-muted tabular-nums">
                      {metric.caption ?? '\u00a0'}
                    </p>
                  ) : null}
                </div>
                <MetricSparkline
                  stroke={(metric.trend.comparison?.changeValue ?? 0) >= 0 ? 'var(--chart-2)' : 'var(--chart-5)'}
                  label={`${metricTrendPeriodLabel}${metric.label}趋势`}
                  values={metric.trend.values}
                />
              </div>
            </Card.Content>
          </Card>
        ))}
      </div>

      {belowMetrics}

      <Card className="mt-4">
        <Card.Content>
          <HeatmapSection days={heatmapDays} modelRows={modelRows}
            onSelectDate={onSelectDate} selectedDate={selectedDate} hidePlatformFilter={tauriDesktop} />
        </Card.Content>
      </Card>
    </section>
  );
}

/** Prefer complete count; fall back to known evidence without "至少" wording. */
function formatRequestCaption(summary: DashboardUsageSummary): string | null {
  const count = summary.requestCount ?? summary.knownRequestCount;
  if (count == null) return null;
  return `${count.toLocaleString('zh-CN')} 次请求`;
}

/** OpenUsage / Anthropic-style: cache_read / (input + cache_read + cache_write). */
function cacheHitRateFromSummary(summary: DashboardUsageSummary): number | null {
  const denom =
    summary.inputTokens +
    summary.cachedInputTokens +
    summary.cacheCreationInputTokens;
  return denom > 0 ? summary.cachedInputTokens / denom : null;
}

function MetricHelpLabel({
  ariaLabel,
  heading,
  label,
  panel,
}: {
  ariaLabel: string;
  heading: string;
  label: string;
  panel: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <p className="min-w-0 truncate text-xs font-medium leading-5 text-muted">
        {label}
      </p>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Tooltip closeDelay={80} delay={120} isDisabled={open}>
          <Button
            aria-label={ariaLabel}
            className="size-4 min-h-4 min-w-4 shrink-0 p-0 text-muted data-[hovered]:bg-transparent data-[hovered]:text-foreground"
            isIconOnly
            size="sm"
            variant="ghost"
          >
            <CircleHelp aria-hidden className="size-3.5" />
          </Button>
          <Tooltip.Content
            className="rounded-xl border-0 bg-overlay p-3 text-overlay-foreground shadow-surface"
            placement="bottom"
          >
            {panel}
          </Tooltip.Content>
        </Tooltip>
        <Popover.Content
          className="rounded-xl border-0 bg-overlay p-0 text-overlay-foreground shadow-surface"
          placement="bottom"
        >
          <Popover.Dialog className="p-3 outline-none">
            <Popover.Heading className="sr-only">{heading}</Popover.Heading>
            {panel}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}

function TotalTokenLabel({
  showRequestHelp,
  summary,
}: {
  showRequestHelp: boolean;
  summary: DashboardUsageSummary;
}) {
  return (
    <MetricHelpLabel
      ariaLabel="总 Token 构成说明"
      heading="总 Token 构成"
      label="总 Token"
      panel={
        <TokenBreakdownPanel
          showRequestHelp={showRequestHelp}
          summary={summary}
        />
      }
    />
  );
}

function InputTokenLabel() {
  return (
    <MetricHelpLabel
      ariaLabel="缓存命中率说明"
      heading="缓存命中率"
      label="输入 Token"
      panel={<CacheHitRateHelpPanel />}
    />
  );
}

function CacheHitRateHelpPanel() {
  return (
    <div className="grid max-w-56 gap-1.5 text-xs">
      <p className="font-medium text-foreground">缓存命中率</p>
      <p className="leading-4 text-muted">
        缓存读 ÷（输入 + 缓存读 + 缓存写）
      </p>
    </div>
  );
}

function HeatmapSection({
  days,
  modelRows,
  selectedDate,
  onSelectDate,
  hidePlatformFilter = false,
}: {
  days: DailyUsageRow[];
  modelRows: ModelBreakdownRow[];
  selectedDate: string | null;
  onSelectDate?: (date: string) => void;
  hidePlatformFilter?: boolean;
}) {
  return (
    <ActivityHeatmap
      days={days}
      embedded
      hidePlatformFilter={hidePlatformFilter}
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
  return (
    <div
      aria-label={`${label} ${exactFormat(value)}`}
      data-slot="metric-value"
      className="min-w-0 truncate text-lg font-semibold leading-7 tracking-tight text-foreground tabular-nums"
      title={exactFormat(value)}
    >
      <AnimatedNumber value={value} format={format} />
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

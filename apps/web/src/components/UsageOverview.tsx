import { useEffect, useMemo, useState } from 'react';
import { IconTrendingDown3, IconTrendingUp3 } from '@tabler/icons-react';
import NumberFlow, { useCanAnimate, type Format } from '@number-flow/react';
import type { DashboardMetricTrend, DashboardMockData } from '@/lib/dashboard-mock-data';
import { TokenDetails } from './TokenDetails';
import { HeatmapTooltip } from './HeatmapTooltip';
import { Button } from '@web/components/ui/button';
import type { DashboardDataSource } from '@/hooks/useDashboardData';
import { useShareSnapshot } from '@/hooks/ShareSnapshotContext';
import { ActivityHeatmap } from '@/components/ActivityHeatmap';
import { UsageDistribution } from './UsageDistribution';
import { UsageTrendCharts } from './UsageTrendCharts';
import { formatTokensExact } from '@/lib/format';
import { localDateNow } from '@/lib/stats-timezone';
import { sourceLabel } from '@/lib/tokens';
import {
  buildToolModelDistributions,
  buildVisibleMetricTrends,
  filterHeatmapDaysBySources,
  filterModelRowsBySources,
  filterToolRows,
  filterTrendRowsBySources,
  summarizeTrendRows,
} from '@/lib/usage-filter';

const metricCell = 'min-w-0 overflow-hidden border-black/6 px-3 py-2.5 sm:px-5 sm:py-3 @max-xs:not-first:border-t @xs:even:border-l @xs:@max-3xl:nth-[n+3]:border-t @3xl:not-first:border-l dark:border-white/6';
function TrendBadge({ trend, days }: { trend: DashboardMetricTrend | null; days: number }) {
  const delta = trend?.changeValue ?? 0;
  const tone = delta > 0
    ? 'bg-lime-200 text-lime-900 dark:bg-lime-950 dark:text-lime-300'
    : delta < 0
      ? 'bg-rose-200 text-rose-900 dark:bg-rose-950 dark:text-rose-300'
      : 'bg-surface-secondary text-muted';
  const change = !trend ? '—' : delta === 0 ? '持平' : `${Math.abs(trend.changePct).toFixed(1)}%`;
  const TrendIcon = delta > 0 ? IconTrendingUp3 : delta < 0 ? IconTrendingDown3 : null;
  const direction = delta > 0 ? '上涨' : delta < 0 ? '下跌' : '';
  const baseline = days === 1 ? '较昨日同时段' : `较此前 ${days} 天`;
  const description = trend ? `${baseline}：${direction}${change}` : '暂无可比数据';
  return (
    <span title={description}
      className={`ml-auto inline-flex items-center gap-0.5 rounded-[6px] px-[5px] py-[2px] text-xs/4 font-extrabold whitespace-nowrap tabular-nums sm:py-[3px] sm:text-[13px]/4 ${tone}`}>
      <span className="sr-only">{description}</span>
      {TrendIcon && <TrendIcon aria-hidden="true" size={14} />}
      <span aria-hidden="true">{change}</span>
    </span>
  );
}

const metricChartSize = 'ml-auto h-8 min-w-0 max-w-1/2 flex-1 sm:h-9';
const metricValueRow = 'mt-2.5 flex gap-2 sm:mt-3';
const chartGrid = 'grid min-w-0 md:grid-cols-2 [&>:last-child]:border-black/6 dark:[&>:last-child]:border-white/6 max-md:[&>:last-child]:border-t md:[&>:last-child]:border-l';
const placeholder = 'rounded bg-surface-secondary';

const currencyFormat: Format = { style: 'currency', currency: 'USD', useGrouping: false };
const tokenFormat: Format = { notation: 'compact', maximumFractionDigits: 1 };

const metricTiming = { duration: 320, easing: 'ease-out' };

function MetricNumber({ value, currency = false, exact }: { value: number; currency?: boolean; exact?: string }) {
  const canAnimate = useCanAnimate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <NumberFlow
      className="shrink-0 whitespace-nowrap font-din text-xl/none font-bold tabular-nums [--number-flow-mask-height:0px] sm:text-2xl/none"
      title={exact}
      transformTiming={metricTiming}
      spinTiming={metricTiming}
      locales="en-US"
      format={currency ? currencyFormat : tokenFormat}
      value={Number.isFinite(value) && (ready || !canAnimate) ? value : 0}
    />
  );
}

function MetricBars({ values, label, color }: { values: number[]; label: string; color: string }) {
  const peak = values.reduce((max, value) => Number.isFinite(value) ? Math.max(max, value) : max, 0);

  return (
    <svg role="img" aria-label={label} className={`metric-bars ${metricChartSize}`}
      viewBox={`0 0 ${Math.max(1, values.length) * 4} 48`} preserveAspectRatio="none" fill={color}>
      {values.map((value, index) => {
        if (!Number.isFinite(value) || value <= 0) return null;
        const height = value / peak * 46;
        return <rect key={index} x={index * 4 + 0.5} y={48 - height} width={3} height={height} rx={0.5} />;
      })}
    </svg>
  );
}

export function UsageSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">正在加载用量</span>
      <div aria-hidden="true" className="@container divide-y divide-black/6 motion-safe:animate-pulse dark:divide-white/6">
        <div className="grid grid-cols-1 @xs:grid-cols-2 @3xl:grid-cols-4">
          {[0, 1, 2, 3].map(index => (
            <div key={index} className={metricCell}>
              <div className="flex items-center justify-between gap-2">
                <div className={`${placeholder} h-5 w-16`} />
                <div className={`${placeholder} h-[22px] w-10`} />
              </div>
              <div className={`${metricValueRow} items-end`}>
                <div className={`${placeholder} h-7 w-20`} />
                <div className={`${placeholder} ${metricChartSize}`} />
              </div>
            </div>
          ))}
        </div>
        <div className="@container px-4 py-3 sm:px-5">
          <div className="usage-heatmap-placeholder" />
        </div>
        <div className={chartGrid}>
          {[0, 1].map(index => (
            <div key={index} className="min-w-0 px-4 py-3 sm:px-5">
              <div className={`${placeholder} h-6 w-28`} />
              <div className={`${placeholder} mt-4 h-[260px]`} />
            </div>
          ))}
        </div>
        <div className={chartGrid}>
          {['tools', 'models'].map(key => (
            <div key={key} className="min-w-0 px-4 py-3 sm:px-5">
              <div className={`${placeholder} h-6 w-20`} />
              <div className={`${placeholder} my-3.5 h-2.5 rounded-full`} />
              <div className={`${placeholder} h-24`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function UsageOverview({
  days,
  data,
  error,
  loading,
  refreshing,
  reload,
  source,
  selectedTools = [],
  selectedModels = [],
}: {
  days: number;
  data: DashboardMockData;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
  source: DashboardDataSource;
  selectedTools?: string[];
  selectedModels?: string[];
}) {
  const { publishSnapshot } = useShareSnapshot();
  const isHourly = days === 1;
  const hasFilters = selectedTools.length > 0 || selectedModels.length > 0;

  const visibleToolRows = useMemo(
    () => filterToolRows(data.toolModelUsage, selectedTools, selectedModels),
    [data.toolModelUsage, selectedModels, selectedTools],
  );
  const visibleDistributions = useMemo(
    () => (hasFilters ? buildToolModelDistributions(visibleToolRows) : data.distributions),
    [data.distributions, hasFilters, visibleToolRows],
  );
  const visibleTrendRows = useMemo(
    () =>
      filterTrendRowsBySources({
        dailyRows: data.rangeDailyUsage,
        hourlyRows: data.todayHourlyUsage,
        hourlyApiRows: data.hourlyApiRows,
        hourlyDate: isHourly ? localDateNow() : undefined,
        heatmapDays: data.heatmapDays,
        modelRows: data.modelRows,
        toolRows: data.toolModelUsage,
        selectedSources: selectedTools,
        selectedModels,
      }),
    [
      data.heatmapDays,
      data.hourlyApiRows,
      data.modelRows,
      data.rangeDailyUsage,
      data.todayHourlyUsage,
      data.toolModelUsage,
      isHourly,
      selectedModels,
      selectedTools,
    ],
  );
  const visibleSummary = useMemo(
    () =>
      hasFilters
        ? summarizeTrendRows({
            dailyRows: visibleTrendRows.dailyRows,
            hourlyRows: visibleTrendRows.hourlyRows,
            hourly: isHourly,
          })
        : data.summary,
    [data.summary, hasFilters, isHourly, visibleTrendRows],
  );
  const visibleMetricTrends = useMemo(
    () =>
      hasFilters
        ? buildVisibleMetricTrends({
            currentDailyRows: visibleTrendRows.dailyRows,
            currentHourlyRows: visibleTrendRows.hourlyRows,
            heatmapDailyRows: data.heatmapDailyUsage,
            heatmapDays: data.heatmapDays,
            hourlyApiRows: data.hourlyApiRows,
            modelRows: data.modelRows,
            toolRows: data.toolModelUsage,
            selectedSources: selectedTools,
            selectedModels,
            rangeDays: days,
            hourly: isHourly,
          })
        : data.metricTrends,
    [
      data.heatmapDailyUsage,
      data.heatmapDays,
      data.hourlyApiRows,
      data.metricTrends,
      data.modelRows,
      data.toolModelUsage,
      days,
      hasFilters,
      isHourly,
      selectedModels,
      selectedTools,
      visibleTrendRows,
    ],
  );
  const visibleHeatmapDays = useMemo(
    () =>
      filterHeatmapDaysBySources(
        data.heatmapDays,
        selectedTools,
        data.modelRows,
        selectedModels,
      ),
    [data.heatmapDays, data.modelRows, selectedModels, selectedTools],
  );
  const visibleModelRows = useMemo(
    () => filterModelRowsBySources(data.modelRows, selectedTools, selectedModels),
    [data.modelRows, selectedModels, selectedTools],
  );

  const shareToolLabel = useMemo(() => {
    const parts: string[] = [];
    if (selectedTools.length > 0) parts.push(selectedTools.map(sourceLabel).join('、'));
    if (selectedModels.length > 0) parts.push(selectedModels.join('、'));
    return parts.length > 0 ? parts.join(' · ') : '全部工具';
  }, [selectedModels, selectedTools]);

  useEffect(() => {
    if (loading || refreshing) return;
    publishSnapshot({
      rangeLabel: days === 1 ? '今天' : `近 ${days} 天`,
      summary: visibleSummary,
      toolLabel: shareToolLabel,
      tools: visibleToolRows.filter(row => row.tokens > 0 || row.costUsd > 0).map(row => ({
        source: row.source, label: sourceLabel(row.source), tokens: row.tokens, costUsd: row.costUsd,
      })),
    });
  }, [days, loading, publishSnapshot, refreshing, shareToolLabel, visibleSummary, visibleToolRows]);

  if (loading || refreshing) {
    return <UsageSkeleton />;
  }
  if (error && source === 'api') {
    return (
      <div role="status" className="flex min-h-40 items-start gap-3 px-4 py-3 sm:px-5 text-sm">
        <span className="text-muted">{error}</span>
        <Button variant="ghost" onClick={() => void reload()} className="cursor-pointer text-accent">刷新</Button>
      </div>
    );
  }

  const rows = isHourly ? visibleTrendRows.hourlyRows : visibleTrendRows.dailyRows;
  const metrics = [
    { label: '预估费用', trend: visibleMetricTrends.totalCostUsd, values: rows.map(row => row.costUsd), value: visibleSummary.totalCostUsd, currency: true },
    { label: '总 Token', trend: visibleMetricTrends.totalTokens, values: rows.map(row => row.totalTokens), details: <TokenDetails summary={visibleSummary} />, value: visibleSummary.totalTokens, exact: formatTokensExact(visibleSummary.totalTokens) },
    { label: '输入 Token', trend: visibleMetricTrends.inputTokens, values: rows.map(row => row.inputTokens), value: visibleSummary.inputTokens, exact: formatTokensExact(visibleSummary.inputTokens) },
    { label: '输出 Token', trend: visibleMetricTrends.outputTokens, values: rows.map(row => row.outputTokens), value: visibleSummary.outputTokens, exact: formatTokensExact(visibleSummary.outputTokens) },
  ];

  return (
    <div className="@container divide-y divide-black/6 dark:divide-white/6">
      <dl className="grid grid-cols-1 @xs:grid-cols-2 @3xl:grid-cols-4">
        {metrics.map(({ label, value, currency, exact, details, trend, values }) => (
          <div key={label} className={metricCell}>
            <dt className="flex flex-wrap items-center gap-1 text-sm/5 text-muted">
              <span className="inline-flex items-center gap-0.5 font-bold">
                {details ?? label}
              </span>
              <TrendBadge trend={trend} days={days} />
            </dt>
            <dd className={`${metricValueRow} items-baseline`}>
              <MetricNumber value={value} currency={currency} exact={exact} />
              <MetricBars
                label={`${label} · ${days === 1 ? '今日每小时' : '近 ' + days + ' 天'}趋势`}
                values={values}
                color={!trend || trend.changeValue === 0 ? 'var(--muted)' : trend.changeValue > 0 ? 'var(--chart-2)' : 'var(--chart-5)'}
              />
            </dd>
          </div>
        ))}
      </dl>

      <section className="min-w-0 px-4 py-3 sm:px-5" aria-label="用量热力图">
        <ActivityHeatmap
          animated
          embedded
          edgePadding={0}
          hideAxisLabels
          hidePlatformFilter
          hideLegend
          days={visibleHeatmapDays}
          models={visibleModelRows}
          tooltipClassName="z-110 w-96 max-w-[calc(100vw-32px)]"
          tooltipSurfaceClassName="web-chart-tooltip web-detail-surface p-4"
          tooltipHalfWidth={208}
          tooltipFlipThreshold={380}
          renderTooltip={props => <HeatmapTooltip {...props} />}
        />
      </section>

      <div className={chartGrid}>
        <UsageTrendCharts days={days} hourlyRows={visibleTrendRows.hourlyRows} dailyRows={visibleTrendRows.dailyRows} />
      </div>
      <div className={chartGrid}>
        <UsageDistribution category="工具" rows={visibleDistributions.tools} />
        <UsageDistribution category="模型" rows={visibleDistributions.models} />
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { buildUsageTrendChartRows, type UsageTrendChartPoint } from '@juejin-opensource/jusage-core/dashboard-trend';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ChartPrimitives';
import type { DashboardDailyUsageRow, DashboardHourlyUsageRow } from '@/lib/dashboard-mock-data';
import { formatTokens, formatTokensExact, formatUsd } from '@/lib/format';
import { localDateNow } from '@/lib/stats-timezone';
import { CompositionBar, CompositionTable } from './UsageComposition';
import { popoverSurfaceClass } from './ui/popover';
import { Segmented } from './Segmented';

const config = {
  totalTokens: { label: '总 Token', color: 'var(--chart-1)' },
  inputTokens: { label: '输入', color: 'var(--chart-1)' },
  outputTokens: { label: '输出', color: 'var(--chart-2)' },
  cachedInputTokens: { label: '缓存', color: 'var(--chart-3)' },
  otherTokens: { label: '其他', color: 'var(--chart-4)' },
  costUsd: { label: '费用', color: 'var(--chart-5)' },
} satisfies ChartConfig;

const breakdown = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'otherTokens'] as const;
const tokenViews = [{ id: 'all', label: '全部' }, { id: 'detail', label: '详细' }] as const;
const trendViews = [{ id: 'tokens', label: 'Token' }, { id: 'cost', label: '费用' }] as const;

function TrendDetails({ point, cost }: { point: UsageTrendChartPoint; cost: boolean }) {
  const rows = breakdown.map(key => ({ key, ...config[key], count: point[key] }));
  const hasShares = point.totalTokens > 0 && rows.reduce((sum, row) => sum + row.count, 0) <= point.totalTokens;
  const tokens = formatTokens(point.totalTokens);
  const amount = formatUsd(point.costUsd);

  return (
    <div className={`${popoverSurfaceClass} w-72 max-w-[90cqw] p-3 text-left`}>
      <p className="text-sm font-semibold tabular-nums">{point.label}</p>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <strong className="font-din text-3xl/9 font-bold tabular-nums"
          title={cost ? amount : formatTokensExact(point.totalTokens)}>
          {cost ? amount : tokens}
        </strong>
        <span className="text-xs text-muted">{cost ? '预估费用' : '总 Token'}</span>
        <span className="ml-auto text-sm text-muted tabular-nums">{cost ? `${tokens} Token` : amount}</span>
      </p>
      <CompositionBar total={point.totalTokens} segments={rows} hasShares={hasShares} />
      <CompositionTable ariaLabel="图表 Token 构成明细" categoryLabel="Token 类别"
        rows={rows} total={point.totalTokens} hasShares={hasShares} />
    </div>
  );
}

function chartAxes(cost = false) {
  return (
    <>
      <CartesianGrid vertical={false} strokeDasharray="3 3" />
      <XAxis dataKey="label" tickFormatter={(label: string) => label.replace(/^\d{4}-(\d{2}-\d{2})$/, '$1')}
        axisLine={false} tickLine={false} minTickGap={16} tickMargin={8} />
      <YAxis axisLine={false} tickLine={false} width={54} tickFormatter={cost ? formatUsd : formatTokens} />
      <ChartTooltip wrapperStyle={{ zIndex: 10 }} content={({ active, payload }) => {
        const point: UsageTrendChartPoint | undefined = payload?.[0]?.payload;
        return active && point ? <TrendDetails point={point} cost={cost} /> : null;
      }} />
    </>
  );
}

const chartSize = '@container mt-3 h-[260px] min-w-0 w-full aspect-auto';
const header = 'flex flex-wrap items-center justify-between gap-2';

export function UsageTrendCharts({ days, hourlyRows, dailyRows }: {
  days: number;
  hourlyRows: DashboardHourlyUsageRow[];
  dailyRows: DashboardDailyUsageRow[];
}) {
  const [tokenView, setTokenView] = useState<'all' | 'detail'>('all');
  const [trendView, setTrendView] = useState<'tokens' | 'cost'>('tokens');
  const today = localDateNow();
  const period = days === 1 ? '今日' : `近 ${days} 天`;
  const tokenTitle = `${period} Token 用量`;
  const trendTitle = `${period}趋势`;
  const empty = <p className="grid h-[260px] place-items-center text-sm text-muted">{period}暂无用量数据</p>;
  const rows = useMemo(() => {
    if (days > 1 && dailyRows.length) {
      return buildUsageTrendChartRows({ hourly: false, hourlyRows: [], dailyRows })
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    if (hourlyRows.some(row => row.totalTokens > 0 || row.costUsd > 0)) {
      return buildUsageTrendChartRows({ hourly: true, hourlyRows, dailyRows: [] });
    }
    const daily = dailyRows.find(row => row.date === today && (row.totalTokens > 0 || row.costUsd > 0));
    if (!daily) return [];
    return buildUsageTrendChartRows({ hourly: false, hourlyRows: [], dailyRows: [daily] })
      .map(row => ({ ...row, label: '今日合计' }));
  }, [days, dailyRows, hourlyRows, today]);

  return (
    <>
      <section className="min-w-0 p-3" aria-label={tokenTitle}>
        <div className={header}>
          <h3 className="text-base font-semibold">{tokenTitle}</h3>
          <Segmented label="Token 趋势展示方式" options={tokenViews} value={tokenView} onChange={setTokenView} />
        </div>
        {rows.length ? (
          <ChartContainer config={config} className={chartSize}>
            <AreaChart accessibilityLayer data={rows} margin={{ top: 8, right: 10 }}>
              {chartAxes()}
              {(tokenView === 'all' ? ['totalTokens'] as const : breakdown).map(key => (
                <Area key={key} dataKey={key} type="monotone" stroke={config[key].color}
                  fill={config[key].color} fillOpacity={0.12} strokeWidth={2}
                  dot={rows.length === 1} isAnimationActive="auto" animationDuration={450} animationEasing="ease-out" />
              ))}
            </AreaChart>
          </ChartContainer>
        ) : empty}
      </section>
      <section className="min-w-0 p-3" aria-label={trendTitle}>
        <div className={header}>
          <h3 className="text-base font-semibold">{trendTitle}</h3>
          <Segmented label={`${trendTitle}指标`} options={trendViews} value={trendView} onChange={setTrendView} />
        </div>
        {rows.length ? (
          <ChartContainer config={config} className={chartSize}>
            <BarChart accessibilityLayer data={rows} maxBarSize={32} margin={{ top: 8, right: 10 }}>
              {chartAxes(trendView === 'cost')}
              {(trendView === 'cost' ? ['costUsd'] as const : breakdown).map(key => (
                <Bar key={key} dataKey={key} stackId="usage" fill={config[key].color} isAnimationActive="auto" animationDuration={450} animationEasing="ease-out" />
              ))}
            </BarChart>
          </ChartContainer>
        ) : empty}
      </section>
    </>
  );
}

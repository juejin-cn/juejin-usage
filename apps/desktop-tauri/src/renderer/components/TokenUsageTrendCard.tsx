import { memo, useId, useMemo, useState } from 'react';
import { Card, Tabs } from '@heroui/react';
import {
  Area,
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
import type {
  DashboardDailyUsageRow,
  DashboardHourlyUsageRow,
} from '@/lib/dashboard-mock-data';
import { formatTokens } from '@/lib/format';
import { cn } from '@/lib/utils';

const SERIES_KEYS = ['input', 'output', 'cache'] as const;
type SeriesKey = (typeof SERIES_KEYS)[number];
type TokenTrendView = 'all' | 'detail';

const CHART_CONFIG = {
  total: { label: '总 Token', color: '#1F6FE5' },
  input: { label: '输入', color: '#71BD99' },
  output: { label: '输出', color: '#397FEC' },
  cache: { label: '缓存', color: '#E9A846' },
} satisfies ChartConfig;

interface TokenUsageTrendCardProps {
  /** When true (today / rangeDays === 1), chart uses hourly buckets. */
  hourly: boolean;
  hourlyRows: DashboardHourlyUsageRow[];
  dailyRows: DashboardDailyUsageRow[];
  /** Heatmap day filter — use 「当日」 copy instead of 「今日」. */
  dayScoped?: boolean;
}

/** Token usage trends, with a concise total view and detailed line breakdown. */
export const TokenUsageTrendCard = memo(function TokenUsageTrendCard({
  hourly,
  hourlyRows,
  dailyRows,
  dayScoped = false,
}: TokenUsageTrendCardProps) {
  const gradientId = useId().replace(/:/g, '');
  const [trendView, setTrendView] = useState<TokenTrendView>('all');

  const rows = useMemo(() => {
    const source = hourly
      ? [...hourlyRows].sort((a, b) => a.hour - b.hour).map((row) => ({
          label: `${row.hour}h`,
          input: Math.max(0, row.inputTokens - row.cachedInputTokens),
          output: row.outputTokens,
          cache: row.cachedInputTokens,
        }))
      : dailyRows.map((row) => ({
          label: row.date,
          input: row.uncachedInputTokens,
          output: row.outputTokens,
          cache: row.cachedInputTokens,
        }));

    return source.map((row) => ({
      ...row,
      total: row.input + row.output + row.cache,
    }));
  }, [dailyRows, hourly, hourlyRows]);

  const title = hourly
    ? dayScoped
      ? '当日 Token 用量'
      : '今日 Token 用量'
    : 'Token 用量';
  const description =
    trendView === 'all'
      ? '总 Token 用量趋势'
      : '输入、输出与缓存 Token 趋势';

  return (
    <Card className="h-full min-w-0 overflow-hidden rounded-2xl">
      <Card.Header className="flex-row flex-nowrap items-start justify-between gap-4 pb-0">
        <div className="min-w-0 flex-1">
          <Card.Title>{title}</Card.Title>
          <Card.Description className="mt-1">{description}</Card.Description>
        </div>
        <Tabs
          aria-label="Token 趋势展示方式"
          className="w-fit shrink-0 text-center"
          selectedKey={trendView}
          onSelectionChange={(key) =>
            setTrendView(String(key) as TokenTrendView)
          }
        >
          <Tabs.ListContainer>
            <Tabs.List
              aria-label="Token 趋势展示方式"
              className="w-fit *:h-6 *:w-fit *:px-3 *:text-sm *:font-normal *:data-[selected=true]:text-accent-foreground"
            >
              <Tabs.Tab id="all">
                <span className="text-xs font-normal">全部</span>
                <Tabs.Indicator className="bg-accent" />
              </Tabs.Tab>
              <Tabs.Tab id="detail">
                <span className="text-xs font-normal">详细</span>
                <Tabs.Indicator className="bg-accent" />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </Card.Header>
      <Card.Content className="pt-4">
        {rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">暂无数据</p>
        ) : (
          <ChartContainer
            className="h-[260px] w-full"
            config={CHART_CONFIG}
            initialDimension={{ width: 720, height: 260 }}
          >
            <ComposedChart
              accessibilityLayer
              data={rows}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                {(trendView === 'all'
                  ? (['total'] as const)
                  : SERIES_KEYS
                ).map((key) => (
                  <linearGradient
                    id={`${gradientId}-${key}`}
                    key={key}
                    x1="0"
                    x2="0"
                    y1="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={`var(--color-${key})`} stopOpacity={0.32} />
                    <stop offset="72%" stopColor={`var(--color-${key})`} stopOpacity={0.08} />
                    <stop offset="100%" stopColor={`var(--color-${key})`} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="label"
                interval={hourly ? 2 : 'preserveEnd'}
                tickFormatter={(value: string) => (hourly ? value : value.slice(5))}
                tickLine={false}
                tickMargin={10}
              />
              <YAxis
                axisLine={false}
                tick={({ payload, y }) => (
                  <text
                    className="fill-muted text-xs"
                    dy="0.32em"
                    textAnchor="start"
                    x={0}
                    y={y}
                  >
                    {formatTokens(Number(payload?.value ?? 0))}
                  </text>
                )}
                tickLine={false}
                width={56}
              />
              <ChartTooltip
                content={<TokenDayTooltip />}
                cursor={{ stroke: 'var(--border)', strokeDasharray: '3 3' }}
              />
              {trendView === 'all' ? (
                <TrendSeries gradientId={gradientId} seriesKey="total" />
              ) : (
                SERIES_KEYS.map((key) => (
                  <TrendSeries gradientId={gradientId} key={key} seriesKey={key} />
                ))
              )}
            </ComposedChart>
          </ChartContainer>
        )}
      </Card.Content>
    </Card>
  );
});

function TrendSeries({
  gradientId,
  seriesKey,
}: {
  gradientId: string;
  seriesKey: 'total' | SeriesKey;
}) {
  return (
    <>
      <Area
        dataKey={seriesKey}
        fill={`url(#${gradientId}-${seriesKey})`}
        fillOpacity={1}
        isAnimationActive={false}
        legendType="none"
        stroke="none"
        type="monotone"
      />
      <Line
        activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 1.5 }}
        dataKey={seriesKey}
        dot={false}
        isAnimationActive={false}
        stroke={`var(--color-${seriesKey})`}
        strokeLinecap="round"
        strokeWidth={2.25}
        type="monotone"
      />
    </>
  );
}

/** Tooltip exposes the complete Token breakdown for the hovered bucket. */
function TokenDayTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown> }>;
}) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload as
    | {
        label?: string;
        output?: number;
        input?: number;
        cache?: number;
        total?: number;
      }
    | undefined;
  if (!row) return null;

  return (
    <div
      className={cn(
        'grid min-w-40 items-start gap-1.5 px-2.5 py-1.5 text-xs font-medium',
        CHART_TOOLTIP_SURFACE_CLASSNAME,
      )}
    >
      <div className="font-medium">{row.label}</div>
      <div className="grid gap-1.5">
        <div className="flex w-full items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: CHART_CONFIG.total.color }}
            />
            合计
          </span>
          <span className="font-mono tabular-nums text-foreground">
            {formatTokens(Number(row.total ?? 0))}
          </span>
        </div>
        {SERIES_KEYS.map((key) => (
          <div className="flex w-full items-center justify-between gap-4" key={key}>
            <span className="flex items-center gap-1.5 text-muted">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: CHART_CONFIG[key].color }}
              />
              {CHART_CONFIG[key].label}
            </span>
            <span className="font-mono tabular-nums text-foreground">
              {formatTokens(Number(row[key] ?? 0))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useId, useMemo, useState } from 'react';
import { Card, Tabs } from '@heroui/react';
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
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from '@/components/ChartPrimitives';
import type {
  DashboardDailyUsageRow,
  DashboardHourlyUsageRow,
} from '@/lib/dashboard-mock-data';
import { formatTokens, formatUsd } from '@/lib/format';

const MAX_DAILY_POINTS = 18;
const CHART_CONFIG = {
  value: { label: '费用', color: 'var(--chart-3)' },
  total: { label: '总 Token', color: '#1F6FE5' },
  inputTokens: { label: '输入', color: 'var(--chart-1)' },
  cachedInputTokens: { label: '缓存输入', color: 'var(--chart-3)' },
  outputTokens: { label: '输出', color: 'var(--chart-2)' },
  otherTokens: { label: '其他', color: 'var(--chart-6)' },
} satisfies ChartConfig;

type TrendMetric = 'tokens' | 'cost';

interface TrendPoint {
  label: string;
  tooltipLabel: string;
  value: number;
  visualValue: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  otherTokens: number;
}

/** Compact combined bar and area chart for the desktop tray popover. */
export function TrayTrendChart({
  hourlyRows,
  isHourly,
  dailyRows,
}: {
  hourlyRows: DashboardHourlyUsageRow[];
  isHourly: boolean;
  dailyRows: DashboardDailyUsageRow[];
}) {
  const [metric, setMetric] = useState<TrendMetric>('tokens');
  const gradientId = useId().replace(/:/g, '');
  const rows = useMemo(
    () => buildTrendPoints({ dailyRows, hourlyRows, isHourly, metric }),
    [dailyRows, hourlyRows, isHourly, metric],
  );
  const xAxisInterval = isHourly
    ? 2
    : Math.max(0, Math.ceil(rows.length / 5) - 1);
  const title = isHourly ? '每小时趋势' : '每日趋势';

  return (
    <Card className="min-w-0 overflow-hidden rounded-2xl p-3" >
      <Card.Header className="flex flex-row items-center justify-between">
        <Card.Title className="text-sm">{title}</Card.Title>
        <Tabs
          selectedKey={metric}
          onSelectionChange={(key) => setMetric(String(key) as TrendMetric)}
        >
          <Tabs.ListContainer>
            <Tabs.List
              aria-label="趋势指标"
              className="w-fit *:h-6 *:w-fit *:px-3 *:text-sm *:font-normal *:data-[selected=true]:text-accent-foreground"
            >
              <Tabs.Tab id="tokens">
                <span className="text-xs font-normal">Token</span>
                <Tabs.Indicator className="bg-accent" />
              </Tabs.Tab>
              <Tabs.Tab id="cost">
                <span className="text-xs font-normal">费用</span>
                <Tabs.Indicator className="bg-accent" />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </Card.Header>
      <Card.Content >
        {metric === 'tokens' ? <TokenLegend /> : null}
        {rows.length === 0 ? (
          <p className="flex h-40 items-center justify-center text-sm text-muted">
            暂无趋势数据
          </p>
        ) : (
          <ChartContainer
            className="h-40 w-full [&_.recharts-bar-rectangle]:cursor-pointer"
            config={CHART_CONFIG}
            initialDimension={{ width: 360, height: 160 }}
          >
            <ComposedChart
              accessibilityLayer
              data={rows}
              // Hidden Y axis has no gutter; daily range labels need extra side room.
              margin={
                isHourly
                  ? { top: 8, right: 12, bottom: 0, left: 12 }
                  : { top: 8, right: 22, bottom: 0, left: 22 }
              }
            >
              {metric === 'cost' ? (
                <defs>
                  <linearGradient
                    id={`${gradientId}-cost`}
                    x1="0"
                    x2="0"
                    y1="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.34} />
                    <stop offset="58%" stopColor="var(--color-value)" stopOpacity={0.1} />
                    <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0} />
                  </linearGradient>
                </defs>
              ) : null}
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="label"
                interval={xAxisInterval}
                tick={{ fontSize: isHourly ? 13 : 11 }}
                tickLine={false}
                tickMargin={8}
              />
              <YAxis allowDataOverflow hide />
              <ChartTooltip
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as TrendPoint | undefined;
                  if (!active || !point) return null;
                  return (
                    <div className="grid min-w-44 gap-2 rounded-[10px] bg-overlay px-3 py-2.5 text-xs shadow-surface">
                      <div className="flex items-center justify-between gap-4">
                        <span className="font-medium text-overlay-foreground">
                          {point.tooltipLabel}
                        </span>
                        <span className="font-semibold text-(--chart-2) tabular-nums">
                        {metric === 'tokens'
                          ? formatTokens(point.value)
                          : formatUsd(point.value)}
                        </span>
                      </div>
                      {metric === 'tokens' ? (
                        <div className="grid gap-1.5 text-muted">
                          <TokenTooltipRow color="var(--chart-1)" label="输入" value={point.inputTokens} />
                          <TokenTooltipRow color="var(--chart-2)" label="输出" value={point.outputTokens} />
                          <TokenTooltipRow color="var(--chart-3)" label="缓存输入" value={point.cachedInputTokens} />
                          {point.otherTokens > 0 ? (
                            <TokenTooltipRow color="var(--chart-6)" label="其他" value={point.otherTokens} />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                }}
                cursor={{ fill: 'var(--surface-secondary)' }}
              />
              {metric === 'tokens' ? (
                <>
                  <Bar dataKey="inputTokens" fill="var(--color-inputTokens)" isAnimationActive={false} maxBarSize={isHourly ? 20 : 28} stackId="tokens" />
                  <Bar dataKey="cachedInputTokens" fill="var(--color-cachedInputTokens)" isAnimationActive={false} maxBarSize={isHourly ? 20 : 28} stackId="tokens" />
                  <Bar dataKey="outputTokens" fill="var(--color-outputTokens)" isAnimationActive={false} maxBarSize={isHourly ? 20 : 28} radius={[4, 4, 0, 0]} stackId="tokens" />
                  <Bar dataKey="otherTokens" fill="var(--color-otherTokens)" isAnimationActive={false} maxBarSize={isHourly ? 20 : 28} radius={[4, 4, 0, 0]} stackId="tokens" />
                  <Line
                    activeDot={false}
                    dataKey="visualValue"
                    dot={false}
                    isAnimationActive={false}
                    name="总 Token"
                    shape={TrayBridgeLineShape}
                    stroke="#1F6FE5"
                    strokeLinecap="round"
                    strokeWidth={2}
                    type="monotone"
                  />
                </>
              ) : (
                <Area
                  dataKey="value"
                  fill={`url(#${gradientId}-cost)`}
                  fillOpacity={1}
                  isAnimationActive={false}
                  stroke="var(--color-value)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  type="monotone"
                />
              )}
            </ComposedChart>
          </ChartContainer>
        )}
      </Card.Content>
    </Card>
  );
}

function buildTrendPoints({
  dailyRows,
  hourlyRows,
  isHourly,
  metric,
}: {
  dailyRows: DashboardDailyUsageRow[];
  hourlyRows: DashboardHourlyUsageRow[];
  isHourly: boolean;
  metric: TrendMetric;
}): TrendPoint[] {
  if (isHourly) {
    return addTrayLineGap([...hourlyRows]
      .sort((a, b) => a.hour - b.hour)
      .map((row) => ({
        label: `${row.hour}h`,
        tooltipLabel: `${row.hourLabel}:00`,
        value: metric === 'tokens' ? row.totalTokens : row.costUsd,
        ...tokenBreakdown({
          totalTokens: row.totalTokens,
          inputTokens: row.inputTokens,
          cachedInputTokens: row.cachedInputTokens,
          outputTokens: row.outputTokens,
        }),
      })));
  }

  const sortedRows = [...dailyRows].sort((a, b) => a.date.localeCompare(b.date));
  const bucketSize = Math.max(1, Math.ceil(sortedRows.length / MAX_DAILY_POINTS));
  const points: Omit<TrendPoint, 'visualValue'>[] = [];

  for (let start = 0; start < sortedRows.length; start += bucketSize) {
    const bucket = sortedRows.slice(start, start + bucketSize);
    const first = bucket[0];
    const last = bucket.at(-1);
    if (!first || !last) continue;
    const totalTokens = bucket.reduce((total, row) => total + row.totalTokens, 0);
    const inputTokens = bucket.reduce((total, row) => total + row.uncachedInputTokens, 0);
    const cachedInputTokens = bucket.reduce((total, row) => total + row.cachedInputTokens, 0);
    const outputTokens = bucket.reduce((total, row) => total + row.outputTokens, 0);
    const value = metric === 'tokens'
      ? totalTokens
      : bucket.reduce((total, row) => total + row.costUsd, 0);
    points.push({
      label: formatBucketLabel(first.date, last.date),
      tooltipLabel: formatBucketTooltip(first.date, last.date),
      value,
      ...tokenBreakdown({ totalTokens, inputTokens, cachedInputTokens, outputTokens }),
    });
  }

  return addTrayLineGap(points);
}

function addTrayLineGap(points: Omit<TrendPoint, 'visualValue'>[]): TrendPoint[] {
  const maxValue = Math.max(0, ...points.map((point) => point.value));
  const visualGap = Math.round(maxValue * 0.0125);
  return points.map((point) => ({
    ...point,
    visualValue: point.value + visualGap,
  }));
}

function buildTrayBridgePath(
  points?: ReadonlyArray<{ x?: number | null; y?: number | null }>,
) {
  const validPoints = (points ?? []).filter(
    (point): point is { x: number; y: number } =>
      Number.isFinite(point.x) && Number.isFinite(point.y),
  );
  if (validPoints.length === 0) return null;

  const smallestGap = validPoints.slice(1).reduce(
    (gap, point, index) => Math.min(gap, point.x - validPoints[index].x),
    Number.POSITIVE_INFINITY,
  );
  const capHalfWidth = Math.min(
    15,
    Math.max(6, Number.isFinite(smallestGap) ? smallestGap * 0.34 : 15),
  );
  const cornerRadius = Math.min(4, capHalfWidth * 0.25);

  const firstX = validPoints[0].x - capHalfWidth + cornerRadius;
  let path = `M ${firstX} ${validPoints[0].y}`;
  for (let index = 0; index < validPoints.length; index += 1) {
    const point = validPoints[index];
    const flatEnd = point.x + capHalfWidth - cornerRadius;
    path += ` L ${flatEnd} ${point.y}`;

    const next = validPoints[index + 1];
    if (!next) continue;
    const connectorEnd = next.x - capHalfWidth + cornerRadius;
    const controlOffset = Math.max(0, (connectorEnd - flatEnd) * 0.5);
    path += ` C ${flatEnd + controlOffset} ${point.y}, ${connectorEnd - controlOffset} ${next.y}, ${connectorEnd} ${next.y}`;
  }

  return {
    firstX,
    lastX: validPoints.at(-1)!.x + capHalfWidth - cornerRadius,
    path,
  };
}

function TrayBridgeLineShape({
  points,
  stroke = 'currentColor',
  strokeWidth = 1,
}: {
  points?: ReadonlyArray<{ x?: number | null; y?: number | null }>;
  stroke?: string;
  strokeWidth?: number | string;
}) {
  const bridgePath = buildTrayBridgePath(points);
  if (!bridgePath) return null;

  return (
    <path
      d={bridgePath.path}
      fill="none"
      stroke={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    />
  );
}

function tokenBreakdown({
  totalTokens,
  inputTokens,
  cachedInputTokens,
  outputTokens,
}: {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}) {
  const input = Math.max(0, inputTokens);
  const cached = Math.max(0, cachedInputTokens);
  const output = Math.max(0, outputTokens);
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    otherTokens: Math.max(0, totalTokens - input - cached - output),
  };
}

function TokenLegend() {
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
      <TokenLegendItem color="var(--chart-1)" label="输入" />
      <TokenLegendItem color="var(--chart-3)" label="缓存输入" />
      <TokenLegendItem color="var(--chart-2)" label="输出" />
      <TokenLegendItem color="var(--chart-6)" label="其他" />
    </div>
  );
}

function TokenLegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function TokenTooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 tabular-nums">
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="font-medium text-overlay-foreground">
        {formatTokens(value)}
      </span>
    </div>
  );
}

function formatDate(date: string): string {
  const [, month = '', day = ''] = date.slice(0, 10).split('-');
  return `${Number(month)}/${Number(day)}`;
}

/** Compact axis label: `8/10–11` when the bucket stays in the same month. */
function formatBucketLabel(firstDate: string, lastDate: string): string {
  const firstLabel = formatDate(firstDate);
  const lastLabel = formatDate(lastDate);
  if (firstDate === lastDate) return firstLabel;
  const [firstMonth] = firstLabel.split('/');
  const [lastMonth, lastDay = ''] = lastLabel.split('/');
  if (firstMonth === lastMonth) return `${firstLabel}–${lastDay}`;
  return `${firstLabel}–${lastLabel}`;
}

function formatBucketTooltip(firstDate: string, lastDate: string): string {
  const firstLabel = formatDate(firstDate);
  const lastLabel = formatDate(lastDate);
  return firstDate === lastDate ? firstLabel : `${firstLabel}–${lastLabel}`;
}

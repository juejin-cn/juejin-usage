import { useMemo } from 'react';
import { Card } from '@heroui/react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { DailyUsageRow } from '@/lib/api';
import { buildTokenTrend } from '@/lib/chart-data';
import { formatTokens, formatUsd } from '@/lib/format';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ChartPrimitives';

interface TokenTrendChartProps {
  data: DailyUsageRow[];
}

/**
 * C1 — 每日 Token 用量趋势。
 * 单层 AreaChart，hover 时同时显示 token 与 cost。
 * `useMemo` 在父级轮询时仅当 `data` 引用变化才重算。
 */
export function TokenTrendChart({ data }: TokenTrendChartProps) {
  const { config, rows } = useMemo(() => buildTokenTrend(data), [data]);

  return (
    <Card>
      <Card.Header>
        <Card.Title>每日 Token 用量</Card.Title>
      </Card.Header>
      <Card.Content>
        {rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted">
            暂无数据
          </p>
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <AreaChart
              data={rows}
              margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
            >
              <defs>
                <linearGradient id="tokensFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--color-tokens)"
                    stopOpacity={0.4}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--color-tokens)"
                    stopOpacity={0.05}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={56}
                tickFormatter={(value: number) => formatTokens(value)}
              />
              <ChartTooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={
                  <ChartTooltipContent
                    indicator="line"
                    labelFormatter={(_label, payload) => {
                      const item = payload?.[0];
                      const date = (item?.payload as { date?: string })?.date;
                      return date ?? _label;
                    }}
                    formatter={(value, name) => {
                      if (name === 'tokens') {
                        return [formatTokens(Number(value)), 'Token'];
                      }
                      if (name === 'costUsd') {
                        return [formatUsd(Number(value)), '费用'];
                      }
                      return [String(value), String(name)];
                    }}
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="tokens"
                stroke="var(--color-tokens)"
                fill="url(#tokensFill)"
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </Card.Content>
    </Card>
  );
}

import { useMemo, useState } from 'react';
import { Card } from '@heroui/react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  XAxis,
  YAxis,
} from 'recharts';
import type { DailyUsageRow, ModelBreakdownRow } from '@/lib/api';
import {
  buildModelColorMap,
  buildModelRanking,
  buildStackedByModel,
} from '@/lib/chart-data';
import { formatPct, formatTokens, formatUsd } from '@/lib/format';
import { sourceLabel } from '@/lib/tokens';
import { cn } from '@/lib/utils';
import { ProviderIcon } from '@/components/ProviderIcon';
import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  ChartTooltipContent,
  useChart,
} from '@/components/ChartPrimitives';

interface ModelUsageCardProps {
  daily: DailyUsageRow[];
  models: ModelBreakdownRow[];
}

const TOP_K = 6;
const TOP_N = 8;

/**
 * BoardUI merged model widget: daily stacked area on top, usage ranking below.
 * Shared blue-adjacent chart colors; tooltips show Agent icon + name before model.
 * Legend toggles series visibility; hover reveals select-all / deselect-all.
 */
export function ModelUsageCard({ daily, models }: ModelUsageCardProps) {
  const colorMap = useMemo(() => buildModelColorMap(models), [models]);

  const stacked = useMemo(
    () => buildStackedByModel(daily, models, TOP_K, colorMap),
    [daily, models, colorMap],
  );

  const ranking = useMemo(
    () => buildModelRanking(models, TOP_N, colorMap),
    [models, colorMap],
  );

  const allSeriesKeys = useMemo(
    () => Object.keys(stacked.config),
    [stacked.config],
  );

  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());

  const modelSources = stacked.modelSources ?? {};

  const toggleSeries = (key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => setHiddenKeys(new Set());
  const deselectAll = () => setHiddenKeys(new Set(allSeriesKeys));

  return (
    <Card>
      <Card.Header>
        <Card.Title>模型</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        {/* —— Daily stacked distribution —— */}
        <div>
          <h3 className="mb-3 text-sm font-medium text-muted">
            每日分布 · Top {TOP_K}
          </h3>
          {stacked.rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">
              暂无数据
            </p>
          ) : (
            <ChartContainer config={stacked.config} className="h-[280px] w-full">
              <AreaChart
                data={stacked.rows}
                margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
              >
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
                        const model = String(name);
                        const source = modelSources[model];
                        const label =
                          model === '其他' ? (
                            <span className="text-muted">其他</span>
                          ) : (
                            <span className="flex min-w-0 items-center gap-1.5">
                              {source && (
                                <ProviderIcon provider={source} size={14} />
                              )}
                              <span className="truncate">
                                {source
                                  ? `${sourceLabel(source)} · ${model}`
                                  : model}
                              </span>
                            </span>
                          );
                        return (
                          <div className="flex w-full items-center justify-between gap-4">
                            {label}
                            <span className="shrink-0 font-mono font-medium tabular-nums text-foreground">
                              {formatTokens(Number(value))}
                            </span>
                          </div>
                        );
                      }}
                    />
                  }
                />
                <ChartLegend
                  content={() => (
                    <ModelSeriesLegend
                      seriesKeys={allSeriesKeys}
                      hiddenKeys={hiddenKeys}
                      onToggle={toggleSeries}
                      onSelectAll={selectAll}
                      onDeselectAll={deselectAll}
                      modelSources={modelSources}
                    />
                  )}
                />
                {allSeriesKeys.map((model) => (
                  <Area
                    key={model}
                    type="monotone"
                    dataKey={model}
                    stackId="models"
                    hide={hiddenKeys.has(model)}
                    stroke={`var(--color-${model})`}
                    fill={`var(--color-${model})`}
                    fillOpacity={model === '其他' ? 0.25 : 0.4}
                    strokeWidth={2}
                    strokeDasharray={model === '其他' ? '4 4' : undefined}
                    isAnimationActive={false}
                    dot={(props) => {
                      const { cx, cy, value, index } = props;
                      if (
                        cx == null ||
                        cy == null ||
                        value == null ||
                        Number(value) <= 0
                      ) {
                        return <g key={`dot-empty-${model}-${index}`} />;
                      }
                      return (
                        <circle
                          key={`dot-${model}-${index}`}
                          cx={cx}
                          cy={cy}
                          r={3}
                          fill={`var(--color-${model})`}
                          stroke="var(--surface)"
                          strokeWidth={1}
                        />
                      );
                    }}
                    activeDot={{
                      r: 5,
                      strokeWidth: 1.5,
                      stroke: 'var(--surface)',
                    }}
                  />
                ))}
              </AreaChart>
            </ChartContainer>
          )}
        </div>

        {/* —— Usage ranking —— */}
        <div className="border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-medium text-muted">
            使用排行 · Top {TOP_N}
          </h3>
          {ranking.rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">
              暂无模型数据
            </p>
          ) : (
            <ChartContainer config={ranking.config} className="h-[260px] w-full">
              <BarChart
                data={ranking.rows}
                layout="vertical"
                margin={{ top: 8, right: 24, left: 8, bottom: 0 }}
              >
                <XAxis
                  type="number"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) => formatTokens(value)}
                />
                <YAxis
                  type="category"
                  dataKey="model"
                  tickLine={false}
                  axisLine={false}
                  width={120}
                  tick={{ fontSize: 12 }}
                />
                <ChartTooltip
                  cursor={{ fill: 'var(--muted)' }}
                  content={
                    <ChartTooltipContent
                      hideLabel
                      formatter={(value, _name, item) => {
                        const payload = item?.payload as
                          | {
                              model: string;
                              source: string;
                              tokens: number;
                              costUsd: number;
                              pct: number;
                            }
                          | undefined;
                        const num = Number(value);
                        const tokens = formatTokens(payload?.tokens ?? num);
                        const cost = formatUsd(payload?.costUsd ?? 0);
                        const pct = formatPct(payload?.pct ?? 0);
                        const source = payload?.source;
                        const model = payload?.model ?? String(_name);

                        return (
                          <div className="flex w-full flex-col gap-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              {source && (
                                <ProviderIcon provider={source} size={14} />
                              )}
                              <span className="truncate font-medium text-foreground">
                                {source
                                  ? `${sourceLabel(source)} · ${model}`
                                  : model}
                              </span>
                            </span>
                            <span className="text-xs font-medium text-muted">
                              {tokens} · {cost} · {pct}
                            </span>
                          </div>
                        );
                      }}
                    />
                  }
                />
                <Bar dataKey="tokens" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {ranking.rows.map((value) => {
                    const row = value as {
                      source: string;
                      model: string;
                      fill?: string;
                      _seriesKey: string;
                    };
                    return (
                      <Cell
                        key={row._seriesKey}
                        fill={row.fill ?? `var(--color-${row._seriesKey})`}
                      />
                    );
                  })}
                </Bar>
              </BarChart>
            </ChartContainer>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}

function ModelSeriesLegend({
  seriesKeys,
  hiddenKeys,
  onToggle,
  onSelectAll,
  onDeselectAll,
  modelSources,
}: {
  seriesKeys: string[];
  hiddenKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  modelSources: Record<string, string>;
}) {
  const { config } = useChart();
  const [hovered, setHovered] = useState(false);

  if (!seriesKeys.length) return null;

  return (
    <div
      className="pt-3"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Fixed slot: invisible when idle so legend items never shift */}
      <div
        className={cn(
          'mb-1 flex h-5 items-center justify-center gap-1 transition-opacity duration-100',
          hovered ? 'visible opacity-100' : 'invisible opacity-0',
        )}
      >
        <button
          type="button"
          tabIndex={hovered ? 0 : -1}
          className="rounded-[6px] border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted shadow-[var(--shadow-card)] transition-colors hover:text-foreground"
          onClick={onSelectAll}
        >
          全选
        </button>
        <button
          type="button"
          tabIndex={hovered ? 0 : -1}
          className="rounded-[6px] border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted shadow-[var(--shadow-card)] transition-colors hover:text-foreground"
          onClick={onDeselectAll}
        >
          全不选
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
        {seriesKeys.map((key) => {
          const itemConfig = config[key];
          const hidden = hiddenKeys.has(key);
          const source = modelSources[key];
          const label =
            key === '其他'
              ? '其他'
              : source
                ? `${sourceLabel(source)} · ${itemConfig?.label ?? key}`
                : String(itemConfig?.label ?? key);
          const color = itemConfig?.color;

          return (
            <button
              key={key}
              type="button"
              onClick={() => onToggle(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-opacity',
                hidden
                  ? 'opacity-40 line-through text-muted'
                  : 'text-foreground hover:opacity-80',
              )}
              title={hidden ? `显示 ${label}` : `隐藏 ${label}`}
            >
              <div
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: hidden
                    ? 'var(--muted)'
                    : color,
                }}
              />
              <span className="max-w-[140px] truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { memo, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Card } from '@heroui/react';
import { CHART_TOOLTIP_SURFACE_CLASSNAME } from '@/components/ChartPrimitives';
import { ProviderIcon } from '@/components/ProviderIcon';
import type { DashboardToolUsageRow } from '@/lib/dashboard-mock-data';
import {
  buildToolModelStackedChart,
  type ToolModelChartSegment,
  type ToolModelChartSeries,
  type ToolModelStackedChartRow,
} from '@/lib/chart-data';
import { formatPct, formatTokens, formatUsd } from '@/lib/format';
import { sourceLabel } from '@/lib/tokens';
import { cn } from '@/lib/utils';

const TOOL_ROW_HEIGHT = 56;
const MAX_VISIBLE_TOOL_ROWS = 7;

function percentage(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1_000) / 10;
}

export const ToolModelUsagePanel = memo(function ToolModelUsagePanel({
  rows,
}: {
  rows: DashboardToolUsageRow[];
}) {
  const headingId = useId();
  const viewTotalTokens = useMemo(
    () => rows.reduce((sum, row) => sum + row.tokens, 0),
    [rows],
  );

  const viewRows = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        pct: percentage(row.tokens, viewTotalTokens),
      })),
    [rows, viewTotalTokens],
  );

  const chart = useMemo(
    () => buildToolModelStackedChart(viewRows),
    [viewRows],
  );
  const chartMaximum = Math.max(
    1,
    viewTotalTokens,
    ...chart.rows.map((row) => row.tokens),
  );
  const hasScrollableRows = chart.rows.length > MAX_VISIBLE_TOOL_ROWS;
  return (
    <Card className="min-w-0 overflow-hidden rounded-2xl">
      <Card.Header className="flex-row items-start gap-3 pb-0">
        <div className="min-w-0">
          <Card.Title id={headingId}>工具与模型用量</Card.Title>
          <Card.Description className="mt-1">
            按平台比较总 Token
          </Card.Description>
        </div>
      </Card.Header>

      <Card.Content className="pt-2">
        {rows.length === 0 ? (
          <p className="flex min-h-52 items-center justify-center px-4 text-center text-sm text-muted">
            暂无工具或模型用量
          </p>
        ) : (
          <div
            aria-labelledby={headingId}
            className="min-w-0"
            role="region"
          >
            {chart.rows.length === 0 ? (
              <p className="mt-4 flex min-h-40 items-center justify-center px-4 text-center text-sm text-muted">
                当前渠道暂无用量
              </p>
            ) : (
              <>
                <div
                  aria-label={
                    hasScrollableRows ? '平台用量列表，可纵向滚动' : undefined
                  }
                  className="min-w-0 overscroll-contain overflow-y-auto pr-1 focus:[outline:none]"
                  style={{
                    maxHeight: TOOL_ROW_HEIGHT * MAX_VISIBLE_TOOL_ROWS,
                  }}
                  tabIndex={hasScrollableRows ? 0 : undefined}
                >
                  <div
                    aria-labelledby={headingId}
                    className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_50px] gap-x-2 sm:gap-x-3"
                    role="img"
                  >
                    <ToolLabelColumn rows={chart.rows} />
                    <ToolStackedBars
                      chartMaximum={chartMaximum}
                      rows={chart.rows}
                      series={chart.series}
                    />
                    <ToolValueColumn rows={chart.rows} />
                  </div>
                </div>

                <AccessibleUsageDetails
                  rows={chart.rows}
                  series={chart.series}
                />
              </>
            )}
          </div>
        )}
      </Card.Content>
    </Card>
  );
});

function ToolLabelColumn({ rows }: { rows: ToolModelStackedChartRow[] }) {
  return (
    <div className="min-w-0" aria-hidden="true">
      {rows.map((row) => (
        <div
          className="flex min-w-0 items-center gap-1.5 sm:gap-2"
          key={row.source}
          style={{ height: TOOL_ROW_HEIGHT }}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white sm:size-8 sm:rounded-lg">
            <ProviderIcon provider={row.source} size={18} onLightBackground />
          </span>
          <span className="min-w-0">
            <span
              className="block truncate text-xs font-semibold text-foreground sm:text-sm"
              title={sourceLabel(row.source)}
            >
              {sourceLabel(row.source)}
            </span>
            <span
              className="mt-0.5 block truncate text-[9px] text-muted tabular-nums sm:text-[11px]"
              title={`${row.modelCount} 个模型 · ${formatUsd(row.costUsd)}`}
            >
              {row.modelCount} 个模型 · {formatUsd(row.costUsd)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

interface HoveredSegment {
  color: string;
  row: ToolModelStackedChartRow;
  segment: ToolModelChartSegment;
  x: number;
  y: number;
}

function ToolStackedBars({
  chartMaximum,
  rows,
  series,
}: {
  chartMaximum: number;
  rows: ToolModelStackedChartRow[];
  series: ToolModelChartSeries[];
}) {
  const [hovered, setHovered] = useState<HoveredSegment | null>(null);

  return (
    <div className="relative min-w-0">
      {rows.map((row) => {
        const barWidthPct = Math.min(100, (row.tokens / chartMaximum) * 100);
        const activeSegments = series.flatMap((item) => {
          const segment = row.segments[item.key];
          if (!segment || segment.tokens <= 0) return [];
          return [{ item, segment }];
        });

        return (
          <div
            className="flex items-center"
            key={row.source}
            style={{ height: TOOL_ROW_HEIGHT }}
          >
            <div className="relative h-7 w-full overflow-hidden rounded-[6px] bg-surface-tertiary">
              <div
                className="absolute inset-y-0 left-0 flex overflow-hidden"
                style={{
                  borderRadius:
                    barWidthPct >= 99.95 ? '6px' : '6px 0 0 6px',
                  width: `${barWidthPct}%`,
                }}
              >
                {activeSegments.map(({ item, segment }) => {
                  const modelWidthPct =
                    row.tokens > 0 ? (segment.tokens / row.tokens) * 100 : 0;

                  return (
                    <div
                      className="h-full cursor-default"
                      key={item.key}
                      onMouseEnter={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setHovered({
                          color: item.color,
                          row,
                          segment,
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                        });
                      }}
                      onMouseLeave={() => setHovered(null)}
                      onMouseMove={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setHovered({
                          color: item.color,
                          row,
                          segment,
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                        });
                      }}
                      style={{
                        backgroundColor: item.color,
                        flex: `0 0 ${modelWidthPct}%`,
                        opacity: item.isUnattributed ? 0.55 : 1,
                      }}
                      title={`${segment.model} · ${formatTokens(segment.tokens)}`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}

      {hovered &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            aria-live="polite"
            className="pointer-events-none fixed z-9999"
            role="status"
            style={{ left: hovered.x, top: hovered.y }}
          >
            <div
              className={cn(
                'grid min-w-52 -translate-x-1/2 -translate-y-[calc(100%+8px)] gap-2 px-3 py-2.5 text-xs',
                CHART_TOOLTIP_SURFACE_CLASSNAME,
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <ProviderIcon provider={hovered.row.source} size={15} />
                <span className="truncate font-semibold">
                  {sourceLabel(hovered.row.source)}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: hovered.color }}
                />
                <span
                  className="truncate font-normal"
                  title={hovered.segment.model}
                >
                  {hovered.segment.model}
                </span>
              </div>
              <span className="text-muted tabular-nums">
                {formatTokens(hovered.segment.tokens)} ·{' '}
                {formatUsd(hovered.segment.costUsd)} ·{' '}
                {formatPct(hovered.segment.pct)}
              </span>
              <span className="text-[10px] text-muted">
                占 {sourceLabel(hovered.row.source)} Token
              </span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function ToolValueColumn({ rows }: { rows: ToolModelStackedChartRow[] }) {
  return (
    <div aria-hidden="true" className="min-w-0">
      {rows.map((row) => (
        <div
          className="flex min-w-0 flex-col items-end justify-center text-right"
          key={row.source}
          style={{ height: TOOL_ROW_HEIGHT }}
        >
          <strong className="text-xs font-semibold text-foreground tabular-nums sm:text-sm">
            {formatPct(row.pct)}
          </strong>
          <span className="mt-0.5 max-w-full truncate text-[9px] text-muted tabular-nums sm:text-[11px]">
            {formatTokens(row.tokens)}
          </span>
        </div>
      ))}
    </div>
  );
}

function AccessibleUsageDetails({
  rows,
  series,
}: {
  rows: ToolModelStackedChartRow[];
  series: ToolModelChartSeries[];
}) {
  return (
    <div className="sr-only">
      <h4>平台与模型精确用量</h4>
      <ol>
        {rows.map((row) => (
          <li key={row.source}>
            {sourceLabel(row.source)}：{formatTokens(row.tokens)}，
            {formatUsd(row.costUsd)}，占全部 Token {formatPct(row.pct)}，
            {row.modelCount} 个模型。
            <ul>
              {series.map((item) => {
                const segment = row.segments[item.key];
                if (!segment) return null;

                return (
                  <li key={item.key}>
                    {segment.model}：{formatTokens(segment.tokens)}，
                    {formatUsd(segment.costUsd)}，占当前平台 Token{' '}
                    {formatPct(segment.pct)}。
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

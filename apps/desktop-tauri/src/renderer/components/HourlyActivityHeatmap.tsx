import { useMemo, useState } from 'react';
import {
  ResponsiveHeatMap,
  type ComputedCell,
  type HeatMapDatum,
} from '@nivo/heatmap';
import { Card } from '@heroui/react';
import { DashboardMetricTabs } from '@/components/DashboardMetricTabs';
import {
  DASHBOARD_HOURS,
  DASHBOARD_WEEKDAYS,
  type DashboardChartMetric,
  type DashboardHourlyUsageRow,
} from '@/lib/dashboard-mock-data';
import { formatDashboardMetric } from '@/lib/dashboard-metric-format';

const INNER_PADDING = 0.12;
const OUTER_PADDING = 0.06;
const CHART_MARGIN = { top: 30, right: 4, bottom: 4, left: 42 };

interface ActivityDatum extends HeatMapDatum, DashboardHourlyUsageRow {
  x: string;
  y: number;
}

const METRICS: Record<
  DashboardChartMetric,
  {
    field: 'totalTokens' | 'costUsd' | 'durationMinutes';
    label: string;
    format: (value: number) => string;
  }
> = {
  tokens: {
    field: 'totalTokens',
    label: 'Token',
    format: (value) => `${formatDashboardMetric('tokens', value)} Token`,
  },
  cost: {
    field: 'costUsd',
    label: '费用',
    format: (value) => formatDashboardMetric('cost', value),
  },
  duration: {
    field: 'durationMinutes',
    label: '时长',
    format: (value) => formatDashboardMetric('duration', value),
  },
};

const ACTIVITY_METRICS = ['tokens', 'cost', 'duration'] as const;

/** Demo 7×24 activity view with metric switching and HeroUI theme colors. */
export function HourlyActivityHeatmap({
  rows,
}: {
  rows: DashboardHourlyUsageRow[];
}) {
  const [metric, setMetric] =
    useState<DashboardChartMetric>('tokens');
  const selectedMetric = METRICS[metric];

  const data = useMemo(
    () =>
      DASHBOARD_WEEKDAYS.map((day) => ({
        id: day,
        data: rows
          .filter((row) => row.day === day)
          .map((row) => ({
            ...row,
            x: row.hourLabel,
            y: row[selectedMetric.field],
          })),
      })),
    [rows, selectedMetric.field],
  );

  const maxValue = useMemo(
    () =>
      Math.max(
        1,
        ...data.flatMap((serie) => serie.data.map((datum) => datum.y)),
      ),
    [data],
  );

  return (
    <Card className="h-full min-w-0 overflow-hidden rounded-2xl">
      <Card.Header className="pb-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <Card.Title>分时活跃</Card.Title>
            <DashboardMetricTabs
              ariaLabel="分时活跃指标"
              metrics={ACTIVITY_METRICS}
              selectedMetric={metric}
              onMetricChange={setMetric}
            />
          </div>
          <Card.Description className="mt-1">
            按星期与小时查看活跃度分布
          </Card.Description>
        </div>
      </Card.Header>

      <Card.Content className="pb-4 pt-2">
        <div className="h-[180px] min-w-0 w-full">
          {/* Nivo 0.99's default ExtraProps type rejects the standard series shape. */}
          <ResponsiveHeatMap<ActivityDatum, object>
            animate={false}
            ariaLabel={`分时活跃热力图，当前指标：${selectedMetric.label}`}
            axisBottom={null}
            axisLeft={{
              tickPadding: 10,
              tickSize: 0,
            }}
            axisRight={null}
            axisTop={{
              tickPadding: 10,
              tickSize: 0,
              tickValues: DASHBOARD_HOURS.filter(
                (_, index) => index % 2 === 0,
              ),
            }}
            borderRadius={4}
            borderWidth={0}
            colors={(cell) =>
              getHeatmapColor(cell.value ?? 0, maxValue)
            }
            data={data}
            emptyColor="rgba(4, 133, 247, 0.08)"
            enableGridX={false}
            enableGridY={false}
            enableLabels={false}
            hoverTarget="cell"
            inactiveOpacity={0.5}
            margin={CHART_MARGIN}
            motionConfig="gentle"
            role="img"
            theme={{
              text: {
                fill: 'var(--muted)',
                fontFamily: 'var(--font-sans)',
                fontSize: 11,
              },
              axis: {
                ticks: {
                  text: {
                    fill: 'var(--muted)',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 11,
                  },
                },
              },
              tooltip: {
                container: {
                  background: 'var(--overlay)',
                  border: 0,
                  borderRadius: 10,
                  boxShadow: 'var(--shadow-surface)',
                  color: 'var(--overlay-foreground)',
                  fontFamily: 'var(--font-sans)',
                  padding: 0,
                },
              },
            }}
            tooltip={({ cell }) => (
              <ActivityTooltip cell={cell} metric={metric} />
            )}
            valueFormat={selectedMetric.format}
            // Nivo forwards these ratios to d3.scaleBand (valid range: 0–1).
            xInnerPadding={INNER_PADDING}
            xOuterPadding={OUTER_PADDING}
            yInnerPadding={INNER_PADDING}
            yOuterPadding={OUTER_PADDING}
          />
        </div>

        <div
          aria-label="活跃度颜色图例，从低到高"
          className="mt-2 flex items-center justify-end gap-2 text-xs text-muted"
        >
          <span>低</span>
          <span
            aria-hidden="true"
            className="h-2 w-28 rounded-full"
            style={{
              background: `linear-gradient(90deg, ${getHeatmapColor(0, 1)}, ${getHeatmapColor(1, 1)})`,
            }}
          />
          <span>高</span>
        </div>
      </Card.Content>
    </Card>
  );
}

function ActivityTooltip({
  cell,
  metric,
}: {
  cell: ComputedCell<ActivityDatum>;
  metric: DashboardChartMetric;
}) {
  return (
    <div className="min-w-40 rounded-[10px] bg-overlay px-3 py-2.5 text-overlay-foreground">
      <p className="text-xs text-muted">
        {cell.data.day} · {cell.data.hourLabel}:00
      </p>
      <p className="mt-1 text-sm font-semibold tabular-nums">
        {METRICS[metric].format(cell.value ?? 0)}
      </p>
    </div>
  );
}

function getHeatmapColor(value: number, maxValue: number) {
  const intensity = Math.max(0, Math.min(value / maxValue, 1));
  const opacity = (0.14 + intensity * 0.86).toFixed(2);

  // Concrete RGB equivalent of HeroUI's default --accent token.
  // React Spring cannot interpolate color-mix() values containing CSS vars.
  return `rgba(4, 133, 247, ${opacity})`;
}

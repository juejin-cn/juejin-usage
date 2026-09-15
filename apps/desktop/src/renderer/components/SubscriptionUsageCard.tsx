import type { ReactNode } from 'react';
import { Card, Chip, ProgressBar } from '@heroui/react';
import { trayPlanLabel } from '../../shared/subscription-plan';

export interface SubscriptionUsageMetric {
  color: string;
  label: string;
  remainingPercent: number | null;
  /** Literal value for balances and credits; percentage remains the bar value. */
  valueText?: string;
}

export interface SubscriptionUsageCardData {
  /** Fixed-size LobeHub brand mark rendered in the card title bar. */
  icon?: ReactNode;
  metrics: readonly SubscriptionUsageMetric[];
  planLabel?: string | null;
  stale?: boolean;
  title: string;
}

interface SubscriptionUsageCardProps {
  data: SubscriptionUsageCardData;
  loading: boolean;
}

/** Shared tray presentation for subscription allowance progress bars. */
export function SubscriptionUsageCard({
  data,
  loading,
}: SubscriptionUsageCardProps) {
  const visiblePlanLabel = trayPlanLabel(data.planLabel);
  const visibleMetrics = data.metrics.filter(
    (metric): metric is SubscriptionUsageMetric & { remainingPercent: number } =>
      metric.remainingPercent !== null,
  );

  // Keep the tray focused on subscriptions with usable allowance data. Empty
  // or in-flight channels do not reserve a card-sized gap in the popover.
  if (loading || visibleMetrics.length === 0) return null;

  return (
    <Card className="min-w-0 overflow-hidden rounded-2xl p-3">
      <Card.Content className="grid grid-rows-[auto_auto] gap-2 p-0">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {data.icon}
            <p className="min-w-0 truncate text-sm font-semibold leading-none tracking-tight text-foreground">
              {data.title}
            </p>
            {data.stale ? (
              <span className="shrink-0 text-[10px] text-muted">旧</span>
            ) : null}
          </div>
          {visiblePlanLabel ? (
            <Chip
              size="sm"
              variant="primary"
            >
              <Chip.Label>{visiblePlanLabel}</Chip.Label>
            </Chip>
          ) : null}
        </div>
        <SubscriptionProgressBars metrics={visibleMetrics} title={data.title} />
      </Card.Content>
    </Card>
  );
}

function SubscriptionProgressBars({
  metrics,
  title,
}: {
  metrics: readonly (SubscriptionUsageMetric & { remainingPercent: number })[];
  title: string;
}) {
  return (
    <div className="grid min-h-12 auto-rows-5 content-start gap-1.5">
      {metrics.slice(0, 3).map((metric) => (
        <div className="flex min-w-0 items-center gap-3" key={metric.label}>
          <span className="shrink-0 text-[11px] font-medium text-muted">{metric.label}</span>
          <ProgressBar
            aria-label={`${title} ${metric.label}剩余 ${Math.round(metric.remainingPercent)}%`}
            className="min-w-0 flex-1"
            maxValue={100}
            size="sm"
            style={{
              gap: 0,
              gridTemplateAreas: '"track"',
              gridTemplateColumns: 'minmax(0, 1fr)',
              gridTemplateRows: 'auto',
            }}
            value={metric.remainingPercent}
          >
            <ProgressBar.Track className="h-1.5 rounded-full bg-surface-secondary">
              <ProgressBar.Fill className="rounded-full" style={{ backgroundColor: metric.color }} />
            </ProgressBar.Track>
          </ProgressBar>
          <span className="shrink-0 whitespace-nowrap text-right text-[11px] font-medium tabular-nums text-foreground">
            {metric.valueText ?? `${Math.round(metric.remainingPercent)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

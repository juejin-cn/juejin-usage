import type { ReactNode } from 'react';
import { Card } from '@heroui/react';

const RING_STEP = 5;

export interface SubscriptionUsageMetric {
  color: string;
  label: string;
  remainingPercent: number | null;
  ringRadius: number;
}

export interface SubscriptionUsageCardData {
  /** Preferred for inline SVG marks that inherit the active theme color. */
  icon?: ReactNode;
  /** Monochrome Lobe marks invert on the dark tray surface. */
  iconMonochrome?: boolean;
  /** Override the default 20px brand-mark size when the artwork needs it. */
  iconSizeClassName?: string;
  iconSrc?: string;
  metrics: readonly SubscriptionUsageMetric[];
  stale?: boolean;
  title: string;
}

interface SubscriptionUsageCardProps {
  data: SubscriptionUsageCardData;
  loading: boolean;
}

/** Shared tray presentation for subscription windows and concentric usage rings. */
export function SubscriptionUsageCard({
  data,
  loading,
}: SubscriptionUsageCardProps) {
  const visibleMetrics = data.metrics.filter(
    (metric): metric is SubscriptionUsageMetric & { remainingPercent: number } =>
      metric.remainingPercent !== null,
  );

  // Keep the tray focused on subscriptions with usable allowance data. Empty
  // or in-flight channels do not reserve a card-sized gap in the popover.
  if (loading || visibleMetrics.length === 0) return null;

  return (
    <Card className="min-w-0 overflow-hidden rounded-2xl px-3 py-2">
      <Card.Content className="grid min-h-22 grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-x-1 p-0">
        <div className="grid min-w-0 content-center gap-2.5">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {data.icon ?? (
              <img
                alt=""
                aria-hidden
                className={`shrink-0 object-contain ${
                  data.iconSizeClassName ?? 'size-5'
                } ${data.iconMonochrome ? 'dark:invert' : ''}`}
                src={data.iconSrc ?? ''}
              />
            )}
            <p className="min-w-0 truncate text-xs font-semibold text-foreground">
              {data.title}
            </p>
            {data.stale ? (
              <span className="shrink-0 text-[10px] text-muted">旧</span>
            ) : null}
          </div>

          <div className="grid h-[2.625rem] content-start pl-1">
            <div className="grid gap-2.5">
              {visibleMetrics.map((metric) => (
                <RemainingMetric key={metric.label} metric={metric} />
              ))}
            </div>
          </div>
        </div>

        <SubscriptionRings metrics={visibleMetrics} title={data.title} />
      </Card.Content>
    </Card>
  );
}

function RemainingMetric({
  metric,
}: {
  metric: SubscriptionUsageMetric & { remainingPercent: number };
}) {
  return (
    <div className="flex min-w-0 items-center justify-start gap-1.5 whitespace-nowrap text-xs font-medium leading-4">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: metric.color }}
      />
      <span className="flex shrink-0 items-center gap-2">
        <span className="shrink-0 text-foreground">{metric.label}</span>
        <span className="shrink-0 text-muted tabular-nums">
          {Math.round(metric.remainingPercent)}%
        </span>
      </span>
    </div>
  );
}

function SubscriptionRings({
  metrics,
  title,
}: {
  metrics: readonly (SubscriptionUsageMetric & { remainingPercent: number })[];
  title: string;
}) {
  const description = metrics
    .map((metric) => `${metric.label} 剩余 ${Math.round(metric.remainingPercent)}%`)
    .join('，');
  return (
    <svg
      aria-label={`${title}：${description}`}
      className="col-start-2 row-start-1 size-22 translate-x-2 self-center justify-self-end"
      role="img"
      viewBox="0 0 72 72"
    >
      {metrics.map((metric) => (
        <Ring
          key={metric.label}
          color={metric.color}
          radius={metric.ringRadius}
          value={metric.remainingPercent}
        />
      ))}
    </svg>
  );
}

function Ring({ color, radius, value }: { color: string; radius: number; value: number }) {
  const circumference = 2 * Math.PI * radius;
  const steppedValue = Math.floor(value / RING_STEP) * RING_STEP;
  return (
    <>
      <circle
        cx="36"
        cy="36"
        fill="none"
        r={radius}
        stroke="var(--surface-secondary)"
        strokeWidth="7"
      />
      <circle
        cx="36"
        cy="36"
        fill="none"
        r={radius}
        stroke={color}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - steppedValue / 100)}
        strokeLinecap="round"
        strokeWidth="7"
        transform="rotate(-90 36 36)"
      />
    </>
  );
}

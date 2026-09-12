import { Tabs } from '@heroui/react';
import type {
  DashboardChartMetric,
  DashboardDistributionMetric,
} from '@/lib/dashboard-mock-data';

type MetricKey = DashboardChartMetric | DashboardDistributionMetric;

const METRIC_LABELS: Record<MetricKey, string> = {
  tokens: 'Token',
  cost: '费用',
  duration: '时长',
};

/** Compact HeroUI Tabs shared by the distribution and heatmap metric switchers. */
export function DashboardMetricTabs<TMetric extends MetricKey>({
  ariaLabel,
  metrics,
  selectedMetric,
  onMetricChange,
  className,
}: {
  ariaLabel: string;
  metrics: readonly TMetric[];
  selectedMetric: TMetric;
  onMetricChange: (metric: TMetric) => void;
  className?: string;
}) {
  return (
    <Tabs
      aria-label={ariaLabel}
      className={`w-fit shrink-0 text-center ${className ?? ''}`}
      selectedKey={selectedMetric}
      onSelectionChange={(key) => onMetricChange(String(key) as TMetric)}
    >
      <Tabs.ListContainer>
        <Tabs.List
          aria-label={ariaLabel}
          className="w-fit *:h-6 *:w-fit *:px-3 *:text-sm *:font-normal *:data-[selected=true]:text-accent-foreground"
        >
          {metrics.map((metric) => (
            <Tabs.Tab id={metric} key={metric}>
              <span className="text-xs font-normal">{METRIC_LABELS[metric]}</span>
              <Tabs.Indicator className="bg-accent" />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

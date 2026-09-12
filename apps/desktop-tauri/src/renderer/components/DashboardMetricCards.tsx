import { CircleQuestion } from '@gravity-ui/icons';
import { Button, Card, Chip, Tooltip } from '@heroui/react';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import { formatTokens, formatTokensExact, formatUsd } from '@/lib/format';
import type {
  DashboardMetricChanges,
  DashboardUsageSummary,
} from '@/lib/dashboard-mock-data';

/** Responsive demo metrics for the dashboard's primary usage summary. */
export function DashboardMetricCards({
  changes,
  summary,
}: {
  changes: DashboardMetricChanges;
  summary: DashboardUsageSummary;
}) {
  const metrics = [
    {
      label: '预估费用',
      value: summary.totalCostUsd,
      changePct: changes.totalCostUsd,
      format: formatUsd,
      exactFormat: formatUsd,
      showTokenHelp: false,
    },
    {
      label: '总 Token',
      value: summary.totalTokens,
      changePct: changes.totalTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      showTokenHelp: true,
    },
    {
      label: '输入 Token',
      value: summary.inputTokens,
      changePct: changes.inputTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      showTokenHelp: true,
    },
    {
      label: '输出 Token',
      value: summary.outputTokens,
      changePct: changes.outputTokens,
      format: formatTokens,
      exactFormat: formatTokensExact,
      showTokenHelp: true,
    },
  ] as const;

  return (
    <section
      aria-label="用量概览"
      className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      {metrics.map((metric) => (
        <Card
          key={metric.label}
          className="min-h-28 min-w-0 rounded-2xl p-4"
        >
          <Card.Content className="flex h-full flex-col justify-between gap-4 p-0">
            <div className="flex items-center gap-1">
              <p className="text-sm font-medium text-muted">
                {metric.label}
              </p>
              {metric.showTokenHelp && <TokenFormatHelp />}
            </div>
            <AnimatedMetricValue
              changePct={metric.changePct}
              exactFormat={metric.exactFormat}
              format={metric.format}
              label={metric.label}
              value={metric.value}
            />
          </Card.Content>
        </Card>
      ))}
    </section>
  );
}

function TokenFormatHelp() {
  return (
    <Tooltip closeDelay={80} delay={100}>
      <Button
        aria-label="查看 Token 缩略换算规则"
        className="h-5 min-h-5 w-5 min-w-5 rounded-full p-0 text-muted"
        isIconOnly
        size="sm"
        variant="ghost"
      >
        <CircleQuestion className="h-3.5 w-3.5" />
      </Button>
      <Tooltip.Content
        className="max-w-64 p-3"
        placement="top"
        showArrow
      >
        <p className="text-xs font-semibold text-foreground">
          Token 缩略换算
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="font-medium tabular-nums">1K</dt>
          <dd>= 1,000 Token</dd>
          <dt className="font-medium tabular-nums">1M</dt>
          <dd>= 100 万 Token</dd>
          <dt className="font-medium tabular-nums">1B</dt>
          <dd>= 10 亿 Token</dd>
          <dt className="font-medium tabular-nums">1T</dt>
          <dd>= 1 万亿 Token</dd>
        </dl>
        <p className="mt-2 text-[11px] text-muted">
          最多保留一位小数，例如 125 万显示为 1.3M。
        </p>
      </Tooltip.Content>
    </Tooltip>
  );
}

function AnimatedMetricValue({
  changePct,
  exactFormat,
  format,
  label,
  value,
}: {
  changePct: number;
  exactFormat: (value: number) => string;
  format: (value: number) => string;
  label: string;
  value: number;
}) {
  const animatedValue = useAnimatedNumber(value);
  const formattedValue = format(animatedValue);

  return (
    <div className="flex min-w-0 items-end justify-between gap-3">
      <p
        aria-label={`${label} ${exactFormat(value)}`}
        className="min-w-0 whitespace-nowrap text-2xl font-semibold tracking-tight text-foreground tabular-nums 2xl:text-3xl"
        title={exactFormat(value)}
      >
        {formattedValue}
      </p>
      <MetricTrend changePct={changePct} />
    </div>
  );
}

function MetricTrend({ changePct }: { changePct: number }) {
  const isIncrease = changePct >= 0;
  const direction = isIncrease ? '上涨' : '下降';

  return (
    <Chip
      aria-label={`${direction} ${Math.abs(changePct).toFixed(2)}%`}
      className="shrink-0"
      color={isIncrease ? 'success' : 'danger'}
      size="sm"
      variant="soft"
    >
      <span aria-hidden="true">{isIncrease ? '↑' : '↓'}</span>
      <Chip.Label className="tabular-nums">
        {Math.abs(changePct).toFixed(2)}%
      </Chip.Label>
    </Chip>
  );
}

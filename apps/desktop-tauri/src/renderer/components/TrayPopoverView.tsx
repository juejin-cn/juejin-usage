import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  Card,
  Chip,
  ProgressBar,
  Skeleton,
  Tabs,
} from '@heroui/react';
import {
  DASHBOARD_RANGE_DAYS,
  ToolChannelSelect,
  type DashboardRange,
} from './DashboardFilter';
import { DashboardRangeSyncOverlay } from './DashboardRangeSyncOverlay';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import { useDashboardData } from '@/hooks/useDashboardData';
import { fetchSyncStatus } from '@/lib/api';
import { formatTokens, formatTokensExact, formatUsd } from '@/lib/format';
import { scheduleAfterPaint } from '@/lib/schedule-after-paint';
import { DATA_SYNCED_EVENT } from '@/lib/shell-events';
import { sourceColor, sourceLabel } from '@/lib/tokens';
import { Check } from '@gravity-ui/icons';
import { ThemeToggle } from './ThemeToggle';
import { TrayTrendChart } from './TrayTrendChart';
import './TrayPopoverView.css';

const POPOVER_MAX_HEIGHT = 700;
const POPOVER_MIN_HEIGHT = 200;

/** Tabs update immediately; data fetch waits until after paint. */
function useDeferredDashboardRange(range: DashboardRange): DashboardRange {
  const [dataRange, setDataRange] = useState(range);

  useEffect(() => {
    if (dataRange === range) return;
    return scheduleAfterPaint(() => {
      setDataRange(range);
    });
  }, [range, dataRange]);

  return dataRange;
}

/** Dedicated React surface loaded inside the macOS tray popover window. */
export function TrayPopoverView() {
  const [range, setRange] = useState<DashboardRange>('last-7-days');
  const dataRange = useDeferredDashboardRange(range);
  const rangeDays = DASHBOARD_RANGE_DAYS[dataRange];
  const { data, error, loading, refreshing, reload } = useDashboardData(rangeDays);
  const {
    summary,
    distributions,
    rangeDailyUsage,
    todayHourlyUsage,
    toolModelUsage,
    metricTrends,
  } = data;
  const headerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const lastSentHeight = useRef(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const reloadSyncStatus = useCallback(async () => {
    try {
      const status = await fetchSyncStatus();
      setLastSyncAt(status.lastSyncAt);
      setNow(Date.now());
    } catch {
      // Keep the last known timestamp. A transient IPC/API failure must not
      // make a previously synced tray look as though it has never synced.
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void reloadSyncStatus();
    let timer = 0;
    const onSynced = () => {
      // Hidden tray popover: skip — the data hook's visibility handler
      // refreshes when the popover is shown again.
      if (document.visibilityState === 'hidden') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void reload();
        void reloadSyncStatus();
      }, 250);
    };
    // The native popover stays mounted while hidden, so mount-only status
    // loading leaves this footer stale after an empty background sync.
    const onFocus = () => {
      void reloadSyncStatus();
    };
    window.addEventListener(DATA_SYNCED_EVENT, onSynced);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(DATA_SYNCED_EVENT, onSynced);
      window.removeEventListener('focus', onFocus);
    };
  }, [reload, reloadSyncStatus]);

  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      if (document.visibilityState !== 'hidden') {
        void reloadSyncStatus();
      }
    };
    const timer = window.setInterval(tick, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [reloadSyncStatus]);

  const availableTools = useMemo(
    () => toolModelUsage.filter((row) => row.tokens > 0),
    [toolModelUsage],
  );

  useEffect(() => {
    const availableSources = new Set(availableTools.map((tool) => tool.source));
    setSelectedTools((current) => {
      const next = current.filter((source) => availableSources.has(source));
      return next.length === current.length ? current : next;
    });
  }, [availableTools]);

  /** Keep the native tray window fitted to the rendered header and content. */
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const measure = () => {
      const header = headerRef.current?.offsetHeight ?? 0;
      const footer = footerRef.current?.offsetHeight ?? 0;
      const natural = header + contentEl.offsetHeight + footer;
      const clamped = Math.ceil(
        Math.min(Math.max(natural, POPOVER_MIN_HEIGHT), POPOVER_MAX_HEIGHT),
      );
      if (clamped === lastSentHeight.current) return;
      lastSentHeight.current = clamped;
      window.tud?.resizeTrayPopover?.(clamped);
    };

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(contentEl);
    if (headerRef.current) resizeObserver.observe(headerRef.current);
    if (footerRef.current) resizeObserver.observe(footerRef.current);
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [loading, error]);

  const metrics = useMemo(
    () => {
      const trendRows = range === 'today' ? todayHourlyUsage : rangeDailyUsage;
      const trendPeriodLabel =
        range === 'today' ? '今日小时' : `近 ${rangeDays} 日`;

      return [
        {
          label: '预估费用',
          value: summary.totalCostUsd,
          trend: metricTrends.totalCostUsd,
          trendDisplay: 'percent' as const,
          format: formatUsd,
          exactFormat: formatUsd,
          trendValues: trendRows.map((row) => row.costUsd),
          trendLabel: `${trendPeriodLabel}预估费用趋势`,
        },
        {
          label: '总 Token',
          value: summary.totalTokens,
          trend: metricTrends.totalTokens,
          trendDisplay: 'percent' as const,
          format: formatTokens,
          exactFormat: formatTokensExact,
          trendValues: trendRows.map((row) => row.totalTokens),
          trendLabel: `${trendPeriodLabel}总 Token 趋势`,
        },
        {
          label: '输入 Token',
          value: summary.inputTokens,
          trend: metricTrends.inputTokens,
          trendDisplay: 'tokens' as const,
          format: formatTokens,
          exactFormat: formatTokensExact,
          trendValues: trendRows.map((row) => row.inputTokens),
          trendLabel: `${trendPeriodLabel}输入 Token 趋势`,
        },
        {
          label: '输出 Token',
          value: summary.outputTokens,
          trend: metricTrends.outputTokens,
          trendDisplay: 'tokens' as const,
          format: formatTokens,
          exactFormat: formatTokensExact,
          trendValues: trendRows.map((row) => row.outputTokens),
          trendLabel: `${trendPeriodLabel}输出 Token 趋势`,
        },
      ] as const;
    },
    [metricTrends, range, rangeDailyUsage, rangeDays, summary, todayHourlyUsage],
  );

  const topTools = useMemo(
    () => availableTools
      .filter(
        (tool) =>
          selectedTools.length === 0 || selectedTools.includes(tool.source),
      )
      .slice(0, 3)
      .map((tool) => ({
        id: tool.source,
        label: sourceLabel(tool.source),
        color: sourceColor(tool.source),
        tokens: tool.tokens,
        costUsd: tool.costUsd,
      })),
    [availableTools, selectedTools],
  );

  const topModels = useMemo(
    () => {
      if (selectedTools.length === 0) return distributions.models.slice(0, 3);

      const selected = new Set(selectedTools);
      const models = new Map<
        string,
        { tokens: number; costUsd: number; bySource: Map<string, number> }
      >();
      for (const tool of availableTools) {
        if (!selected.has(tool.source)) continue;
        for (const model of tool.models) {
          const entry = models.get(model.model) ?? {
            tokens: 0,
            costUsd: 0,
            bySource: new Map<string, number>(),
          };
          entry.tokens += model.tokens;
          entry.costUsd += model.costUsd;
          entry.bySource.set(
            tool.source,
            (entry.bySource.get(tool.source) ?? 0) + model.tokens,
          );
          models.set(model.model, entry);
        }
      }

      return [...models.entries()]
        .map(([model, usage]) => {
          const dominantSource = [...usage.bySource.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0]?.[0] ?? 'unknown';
          return {
            id: model,
            label: model,
            color: sourceColor(dominantSource),
            tokens: usage.tokens,
            costUsd: usage.costUsd,
          };
        })
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 3);
    },
    [availableTools, distributions.models, selectedTools],
  );

  const modelProgressTotal = useMemo(() => {
    if (selectedTools.length === 0) return summary.totalTokens;
    const selected = new Set(selectedTools);
    return availableTools.reduce(
      (total, tool) => total + (selected.has(tool.source) ? tool.tokens : 0),
      0,
    );
  }, [availableTools, selectedTools, summary.totalTokens]);

  return (
    <div className="tray-popover bg-background font-sans text-foreground">
      <header
        ref={headerRef}
        className="tray-popover__header flex flex-col gap-2.5 px-4 py-3"
      >
        <div className="flex items-center justify-between">
          <h1 className="text-md text-foreground">用量概览</h1>
          <ThemeToggle />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Tabs
            className="w-fit shrink-0 text-center"
            selectedKey={range}
            onSelectionChange={(key) => {
              const next = String(key) as DashboardRange;
              if (next === range) return;
              setRange(next);
            }}
          >
            <Tabs.ListContainer>
              <Tabs.List
                aria-label="时间范围"
                className="w-fit *:h-6 *:w-fit *:px-3 *:text-sm *:font-normal *:transition-none! *:data-[selected=true]:text-accent-foreground"
              >
                <Tabs.Tab className="transition-none!" id="today">
                  <span className="text-xs font-normal">今天</span>
                  <Tabs.Indicator className="bg-accent transition-none!" />
                </Tabs.Tab>
                <Tabs.Tab className="transition-none!" id="last-7-days">
                  <span className="text-xs font-normal">7D</span>
                  <Tabs.Indicator className="bg-accent transition-none!" />
                </Tabs.Tab>
                <Tabs.Tab className="transition-none!" id="last-30-days">
                  <span className="text-xs font-normal">30D</span>
                  <Tabs.Indicator className="bg-accent transition-none!" />
                </Tabs.Tab>
                <Tabs.Tab className="transition-none!" id="last-90-days">
                  <span className="text-xs font-normal">90D</span>
                  <Tabs.Indicator className="bg-accent transition-none!" />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>

          <div className="flex min-h-8 min-w-0 shrink-0 items-center">
            {availableTools.length > 0 ? (
              <ToolChannelSelect
                selectedTools={selectedTools}
                tools={availableTools}
                onChange={setSelectedTools}
              />
            ) : null}
          </div>
        </div>
      </header>

      <div className="tray-popover__body">
        <div ref={contentRef} className="px-4 pb-4">
          {loading ? (
            <div className="relative isolate min-h-40">
              <DashboardRangeSyncOverlay visible />
              <TrayLoadingSkeleton />
            </div>
          ) : error ? (
            <div className="flex min-h-40 items-center justify-center px-2 text-center text-xs text-muted">
              {error}
            </div>
          ) : (
            <div className="relative isolate grid min-h-40 gap-3.5">
              <DashboardRangeSyncOverlay visible={refreshing} />
              <section aria-label="用量指标" className="grid grid-cols-2 gap-2.5">
                {metrics.map((metric) => (
                  <Card
                    key={metric.label}
                    className="h-[5.5rem] min-h-[5.5rem] min-w-0 overflow-hidden rounded-2xl p-3"
                  >
                    <Card.Content className="grid h-full grid-rows-[1.25rem_1fr] content-start gap-3 p-0">
                      <div className="flex h-5 min-w-0 items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium leading-5 text-muted">
                          {metric.label}
                        </p>
                        <div className="flex h-5 shrink-0 items-center justify-end">
                          {metric.trend ? (
                            <MetricTrend
                              display={metric.trendDisplay}
                              trend={metric.trend}
                            />
                          ) : null}
                        </div>
                      </div>
                      <div className="grid grid-cols-[minmax(0,1fr)_64px] items-end gap-2">
                        <AnimatedMetricValue
                          exactFormat={metric.exactFormat}
                          format={metric.format}
                          label={metric.label}
                          value={metric.value}
                        />
                        <MetricSparkline
                          isIncrease={(metric.trend?.changeValue ?? 0) >= 0}
                          label={metric.trendLabel}
                          values={metric.trendValues}
                        />
                      </div>
                    </Card.Content>
                  </Card>
                ))}
              </section>

              <TrayTrendChart
                dailyRows={rangeDailyUsage}
                hourlyRows={todayHourlyUsage}
                isHourly={range === 'today'}
              />

              {topTools.length > 0 && (
                <DistributionMiniCard
                  rows={topTools}
                  title="工具分布 Top 3"
                  totalTokens={summary.totalTokens}
                />
              )}

              {topModels.length > 0 && (
                <DistributionMiniCard
                  rows={topModels}
                  title="模型分布 Top 3"
                  totalTokens={modelProgressTotal}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <footer
        ref={footerRef}
        className="tray-popover__footer flex items-center px-4 py-2.5"
      >
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground"
        >
          <Check className="size-3" />
        </span>
        <span
          className="ml-1.5 text-xs leading-none text-muted"
          title={lastSyncAt ? new Date(lastSyncAt).toLocaleString() : undefined}
        >
          最近同步：{formatLastSyncTime(lastSyncAt, now)}
        </span>
        <button
          type="button"
          className="ml-auto text-xs leading-none text-accent-soft-foreground transition-colors hover:text-foreground"
          onClick={() => window.tud?.showMainWindow?.()}
        >
          打开主窗口
        </button>
      </footer>
    </div>
  );
}

/** Preserve the tray's final content rhythm while the first dataset loads. */
function TrayLoadingSkeleton() {
  return (
    <div aria-label="用量数据加载中" className="grid gap-3.5" role="status">
      <section aria-hidden="true" className="grid grid-cols-2 gap-2.5">
        {Array.from({ length: 4 }, (_, index) => (
          <Card className="h-[5.5rem] min-h-[5.5rem] min-w-0 overflow-hidden rounded-2xl p-3" key={index}>
            <Card.Content className="grid grid-rows-[auto_auto] content-start gap-4 p-0">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3 w-14 rounded-md" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_64px] items-end gap-2">
                <Skeleton className="h-6 w-20 rounded-md" />
                <Skeleton className="h-6 w-16 justify-self-end rounded-md" />
              </div>
            </Card.Content>
          </Card>
        ))}
      </section>

      <Card aria-hidden="true" className="overflow-hidden rounded-2xl p-3">
        <Card.Header className="flex-row items-center justify-between">
          <Skeleton className="h-4 w-20 rounded-md" />
          <Skeleton className="h-6 w-24 rounded-lg" />
        </Card.Header>
        <Card.Content>
          <Skeleton className="h-40 w-full rounded-xl" />
        </Card.Content>
      </Card>

      {Array.from({ length: 2 }, (_, index) => (
        <Card aria-hidden="true" className="rounded-2xl" key={index}>
          <Card.Header className="pb-0">
            <Skeleton className="h-4 w-28 rounded-md" />
          </Card.Header>
          <Card.Content className="space-y-3 pt-4">
            {Array.from({ length: 3 }, (_, row) => (
              <div className="grid grid-cols-[1fr_5rem] items-center gap-3" key={row}>
                <Skeleton className="h-4 w-28 rounded-md" />
                <Skeleton className="h-4 w-16 justify-self-end rounded-md" />
              </div>
            ))}
          </Card.Content>
        </Card>
      ))}
    </div>
  );
}

function formatLastSyncTime(lastSyncAt: string | null, now: number): string {
  if (!lastSyncAt) return '从未';
  const date = new Date(lastSyncAt);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) return '未知';

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 60) return '刚刚';

  if (elapsedSeconds < 7 * 24 * 60 * 60) {
    return formatDistanceToNow(date, { addSuffix: true, locale: zhCN });
  }

  return format(date, 'M/d HH:mm', { locale: zhCN });
}

function MetricTrend({
  display,
  trend,
}: {
  display: 'percent' | 'tokens';
  trend: { changePct: number; changeValue: number };
}) {
  const isIncrease = trend.changeValue >= 0;
  const direction = isIncrease ? '上涨' : '下降';
  const label =
    display === 'tokens'
      ? `${isIncrease ? '+' : '−'}${formatTokens(Math.abs(trend.changeValue))}`
      : `${Math.abs(trend.changePct).toFixed(1)}%`;

  return (
    <Chip
      aria-label={`${direction} ${label}`}
      className="shrink-0"
      color={isIncrease ? 'success' : 'danger'}
      size="sm"
      variant="soft"
    >
      <span aria-hidden="true">{isIncrease ? '↑' : '↓'}</span>
      <Chip.Label className="tabular-nums">{label}</Chip.Label>
    </Chip>
  );
}

function AnimatedMetricValue({
  exactFormat,
  format,
  label,
  value,
}: {
  exactFormat: (value: number) => string;
  format: (value: number) => string;
  label: string;
  value: number;
}) {
  const animatedValue = useAnimatedNumber(value);

  return (
    <span
      aria-label={`${label} ${exactFormat(value)}`}
      className="min-w-0 truncate text-lg font-semibold leading-7 tracking-tight text-foreground tabular-nums"
      title={exactFormat(value)}
    >
      {format(animatedValue)}
    </span>
  );
}

/** Compact, non-interactive trend cue for metric cards. */
function MetricSparkline({
  isIncrease,
  label,
  values,
}: {
  isIncrease: boolean;
  label: string;
  values: number[];
}) {
  const gradientId = useId().replace(/:/g, '');
  const points = useMemo(
    () => values.filter((value) => Number.isFinite(value)),
    [values],
  );

  if (points.length < 2) {
    return (
      <div
        aria-hidden="true"
        className="h-6 w-16 justify-self-end"
      />
    );
  }

  const width = 64;
  const height = 24;
  const padding = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stroke = isIncrease ? 'var(--chart-2)' : 'var(--chart-5)';
  const path = points
    .map((value, index) => {
      const x =
        padding +
        (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
      const y =
        height -
        padding -
        ((value - min) / span) * (height - padding * 2);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div
      aria-label={label}
      className="pointer-events-none h-6 w-16 justify-self-end"
      role="img"
    >
      <svg
        aria-hidden="true"
        className="h-full w-full overflow-visible"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.24} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path
          d={`${path} L ${width - padding} ${height} L ${padding} ${height} Z`}
          fill={`url(#${gradientId})`}
        />
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

function DistributionMiniCard({
  title,
  rows,
  totalTokens,
}: {
  title: string;
  rows: Array<{ id: string; label: string; color: string; tokens: number; costUsd: number }>;
  totalTokens: number;
}) {
  return (
    <Card className="min-w-0 rounded-2xl p-3">
      <Card.Content className="grid gap-2.5 p-0">
        <p className="text-xs font-medium text-muted">{title}</p>
        {rows.map((row) => {
          const pct = totalTokens > 0 ? (row.tokens / totalTokens) * 100 : 0;
          return (
            <div
              className="grid grid-cols-[minmax(0,132px)_minmax(0,1fr)_auto] items-center gap-x-2"
              key={row.id}
            >
              <span className="truncate text-xs font-medium text-foreground">
                {row.label}
              </span>
              <ProgressBar
                aria-label={`${row.label} 占比 ${pct.toFixed(1)}%`}
                className="w-full"
                maxValue={100}
                size="sm"
                value={pct}
              >
                <ProgressBar.Track className="h-2 rounded-full bg-surface-secondary">
                  <ProgressBar.Fill
                    className="rounded-full"
                    style={{ backgroundColor: row.color }}
                  />
                </ProgressBar.Track>
              </ProgressBar>
              <span className="text-right text-xs font-semibold tabular-nums text-foreground">
                {formatTokens(row.tokens)}
              </span>
            </div>
          );
        })}
      </Card.Content>
    </Card>
  );
}

import { useEffect, useId, useState, type ReactNode } from 'react';
import { differenceInCalendarDays, format } from 'date-fns';
import { Button, Card, Chip, ProgressBar } from '@heroui/react';
import { CalendarXmark, ChevronDown, ChevronUp, ArrowRotateRight } from '@gravity-ui/icons';
import { flattenedSubscriptionDetails, subscriptionPercentageTone, type SubscriptionDetailRow, type SubscriptionDetailSection } from '../lib/subscription-details';
import { selectProgressMetrics } from '../lib/subscription-progress';
import { Image as ImageIcon, Video as VideoIcon } from 'lucide-react';
import { visibleSubscriptionPlanLabel } from '@juejin-opensource/jusage-core/subscription/shared/subscription-plan';

export interface SubscriptionUsageMetric {
  poolKey?: string;
  group?: 'image' | 'video';
  collapsedHidden?: boolean;
  valueTag?: '已用' | '剩余';
  color: string;
  label: string;
  remainingPercent: number | null;
  /** Official allowance reset timestamp, in Unix seconds. */
  resetsAt?: number | null;
  /** Show a subscription expiry as days remaining instead of a reset time. */
  resetDisplay?: 'date-time' | 'days-only';
  /** Literal value for balances and credits; percentage remains the bar value. */
  valueText?: string;
  /** A balance has no meaningful percentage denominator. */
  hideProgress?: boolean;
}

export interface SubscriptionUsageCardData {
  /** Fixed-size LobeHub brand mark rendered in the card title bar. */
  icon?: ReactNode;
  headerAccessory?: ReactNode;
  metrics: readonly SubscriptionUsageMetric[];
  /** null displays every pool; other cards default to three. */
  metricLimit?: number | null;
  expandMetrics?: boolean;
  /** Label/value rows always visible beneath the header. */
  summaryRows?: readonly SubscriptionDetailRow[];
  details?: readonly SubscriptionDetailSection[];
  /** Flat label/value rows inside the collapsible details area. */
  detailRows?: readonly SubscriptionDetailRow[];
  planLabel?: string | null;
  showFreePlan?: boolean;
  stale?: boolean;
  hasAccount?: boolean;
  message?: string | null;
  title: string;
  /** Provider-reported subscription expiry, in Unix seconds; never a quota reset. */
  subscriptionExpiresAt?: number | null;
}

interface SubscriptionUsageCardProps {
  data: SubscriptionUsageCardData;
  loading: boolean;
  onRefresh: () => void;
  /** Optional feedback keeps a failed channel visible even without metrics. */
  feedback?: ReactNode;
}

/** Shared desktop presentation for subscription allowance progress bars. */
export function SubscriptionUsageCard(props: SubscriptionUsageCardProps) {
  const { data, feedback } = props;
  const visible = Boolean(feedback || data.metrics.some((metric) =>
    metric.remainingPercent !== null && Number.isFinite(metric.remainingPercent))
    || data.summaryRows?.length || data.detailRows?.length || data.headerAccessory || (data.hasAccount && data.message) || data.details?.some((section) => section.kind === 'quota'));
  const [present, setPresent] = useState(visible);
  const [lastVisible, setLastVisible] = useState({ data, feedback });

  useEffect(() => {
    if (visible) {
      setPresent(true);
      setLastVisible({ data, feedback });
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), 180);
    return () => window.clearTimeout(timer);
  }, [visible, data, feedback]);

  if (!visible && !present) return null;
  return <SubscriptionUsageCardContent {...props} {...(visible ? { data, feedback } : lastVisible)} visible={visible} />;
}

function SubscriptionUsageCardContent({
  data,
  loading,
  onRefresh,
  feedback,
  visible,
}: SubscriptionUsageCardProps & { visible: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  const detailsId = useId();
  const metricsId = useId();
  const planLabel = visibleSubscriptionPlanLabel(data.planLabel, data.showFreePlan);
  const expiryDate = subscriptionTimestampToDate(data.subscriptionExpiresAt);
  const expiryDays = expiryDate ? differenceInCalendarDays(expiryDate, new Date()) : null;
  const visibleMetrics = data.metrics.filter(
    (metric): metric is SubscriptionUsageMetric & { remainingPercent: number } =>
      metric.remainingPercent !== null && Number.isFinite(metric.remainingPercent),
  );
  const displayedMetrics = selectProgressMetrics(visibleMetrics, collapsed, data.metricLimit === undefined ? 3 : data.metricLimit, data.expandMetrics);
  const previewMetrics = selectProgressMetrics(visibleMetrics, true, data.metricLimit === undefined ? 3 : data.metricLimit, data.expandMetrics);
  const hasMoreMetrics = Boolean(data.expandMetrics && visibleMetrics.length > previewMetrics.length);
  const detailRows = [...(data.detailRows ?? []), ...flattenedSubscriptionDetails(data.details ?? [], displayedMetrics)];
  const hasDetails = detailRows.length > 0 || hasMoreMetrics;

  // Keep existing metrics visible while refreshing; hide channels without data or feedback.
  if (!feedback && visibleMetrics.length === 0 && !(data.hasAccount && data.message)
    && !data.summaryRows?.length && !data.detailRows?.length && !data.headerAccessory && !data.details?.some((section) => section.kind === 'quota')) return null;

  return (
    <Card
      aria-busy={loading}
      aria-hidden={!visible}
      inert={!visible}
      data-visible={visible}
      data-metric-count={displayedMetrics.length}
      className="subscription-usage-card min-w-0 self-start overflow-hidden rounded-2xl px-3 pb-3 pt-2"
    >
      <Card.Content className="grid content-start gap-0 p-0">
        <div className="grid h-7 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {data.icon ? (
              <span className="flex size-4.5 shrink-0 items-center justify-center">{data.icon}</span>
            ) : null}
            <Card.Title
              className="min-w-0 truncate text-[13px] font-medium leading-5 tracking-normal text-foreground"
              style={{ fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
            >
              {data.title}
            </Card.Title>
            {planLabel ? (
              <Chip className="h-4.5 max-w-28 shrink-0 px-1.5 text-[11px] leading-4" color="accent" size="sm" variant="soft">
                <Chip.Label
                  className="truncate"
                  style={{ fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
                >
                  {planLabel}
                </Chip.Label>
              </Chip>
            ) : null}
            {data.headerAccessory}
            {data.stale ? (
              <span className="shrink-0 text-[11px] leading-4 text-muted">旧</span>
            ) : null}
          </div>
          <div aria-label={`${data.title} 订阅操作`} className="flex shrink-0 items-center gap-0">
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={`刷新 ${data.title} 订阅额度`}
              className="size-7 min-h-7 min-w-7 p-0 motion-safe:transition-transform motion-safe:duration-150 motion-safe:data-[pressed=true]:scale-90 motion-reduce:transform-none"
              isDisabled={loading}
              onPress={onRefresh}
            >
              <ArrowRotateRight aria-hidden="true" stroke="currentColor" strokeWidth={0.25} strokeLinejoin="round" className={`size-3.5 text-muted ${loading ? 'motion-safe:animate-spin' : ''}`} />
            </Button>
            {hasDetails ? <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-controls={data.expandMetrics ? `${metricsId}${detailRows.length ? ` ${detailsId}` : ''}` : detailsId}
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? '展开' : '折叠'} ${data.title} 订阅详情`}
              className="size-7 min-h-7 min-w-7 p-0 motion-safe:transition-transform motion-safe:duration-150 motion-safe:data-[pressed=true]:scale-90 motion-reduce:transform-none"
              onPress={() => setCollapsed((value) => !value)}
            >
              {collapsed ? (
                <ChevronDown aria-hidden="true" stroke="currentColor" strokeWidth={0.25} strokeLinejoin="round" className="size-4 text-muted" />
              ) : (
                <ChevronUp aria-hidden="true" stroke="currentColor" strokeWidth={0.25} strokeLinejoin="round" className="size-4 text-muted" />
              )}
            </Button> : null}
          </div>
        </div>
        <div className="mt-2 grid gap-2" id={data.expandMetrics ? metricsId : undefined}>
          {visibleMetrics.length > 0 ? <SubscriptionProgressBars metrics={displayedMetrics} title={data.title} /> : null}
          {collapsed && expiryDate && expiryDays !== null ? (
            <p className="flex items-center gap-1 text-xs font-normal leading-[18px] text-muted" aria-label="订阅到期时间">
              <CalendarXmark aria-hidden="true" className="size-3.5 shrink-0" />
              <time dateTime={expiryDate.toISOString()}>{format(expiryDate, 'yyyy/MM/dd')}</time>
              <span className="ml-1">{expiryDays > 0 ? `${expiryDays}d` : expiryDays === 0 ? '今日到期' : '已到期'}</span>
            </p>
          ) : null}
          {data.summaryRows?.length ? <SubscriptionDetailRows rows={data.summaryRows} /> : null}
          {feedback ?? (data.hasAccount && data.message ? <p role="status" className="text-xs leading-[18px] text-muted">{data.message}</p> : null)}
        </div>
        {detailRows.length > 0 ? <div
          aria-hidden={collapsed}
          className={`grid motion-safe:transition-[grid-template-rows,opacity,margin-top] motion-safe:duration-250 motion-safe:ease-out ${collapsed ? 'mt-0 grid-rows-[0fr] opacity-0' : 'mt-3 grid-rows-[1fr] opacity-100'}`}
          id={detailsId}
          inert={collapsed}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              className="grid text-[13px] font-normal leading-5"
              style={{ fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
            >
              <SubscriptionDetailRows rows={detailRows} />
            </div>
          </div>
        </div> : null}
      </Card.Content>
    </Card>
  );
}

function SubscriptionDetailRows({ rows }: { rows: readonly SubscriptionDetailRow[] }) {
  return (
    <dl className="grid gap-1.5 text-[13px] font-normal leading-5">
      {rows.map((row, rowIndex) => (
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-3" key={`${row.label}-${rowIndex}`}>
          <dt className="text-muted">{row.label}</dt>
          <dd className={`flex min-w-0 items-baseline justify-end gap-1.5 text-right tabular-nums ${detailToneClass(row.tone)}`}>
            {row.tag ? <span className="shrink-0 rounded-full bg-default px-1.5 text-[11px] leading-[18px] text-muted">{row.tag}</span> : null}
            <span className="min-w-0 break-words">{row.value}</span>
          </dd>
        </div>
      ))}
    </dl>
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
    <div className="grid content-start gap-3 text-xs leading-[18px]">
      {metrics.map((metric) => {
        const daysOnly = metric.resetDisplay === 'days-only';
        const resetDate = subscriptionTimestampToDate(metric.resetsAt);
        const timeOnly = metric.label === '5h' || metric.label === '1d';
        const resetLabel = daysOnly
          ? formatSubscriptionDaysRemaining(metric.resetsAt)
          : timeOnly && resetDate ? format(resetDate, 'HH:mm') : formatSubscriptionResetTime(metric.resetsAt);
        const resetTitle = daysOnly
          ? formatSubscriptionExpiryDate(metric.resetsAt)
          : formatSubscriptionResetTime(metric.resetsAt, new Date(), true);
        const timeKind = daysOnly ? '到期' : '刷新时间';
        const tone = subscriptionPercentageTone(metric.remainingPercent);
        const remainingColor = metric.hideProgress ? 'text-foreground' : detailToneClass(tone);
        const fillColor = tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : tone === 'danger' ? 'bg-danger' : 'bg-muted';
        return (
          <div
            className="grid min-w-0 gap-[5px]"
            key={metric.poolKey ?? metric.label}
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                {metric.group ? (
                  <span className="inline-flex shrink-0 items-center text-muted" role="img" aria-label={metric.group === 'image' ? '图片' : '视频'} title={metric.group === 'image' ? '图片' : '视频'}>
                    {metric.group === 'image' ? <ImageIcon aria-hidden="true" className="size-3.5" /> : <VideoIcon aria-hidden="true" className="size-3.5" />}
                  </span>
                ) : null}
                <span className="truncate font-normal text-foreground">{metric.label}</span>
                {metric.valueTag ? <span className="shrink-0 rounded-full bg-default px-1.5 text-[11px] leading-[18px] text-muted">{metric.valueTag}</span> : null}
                <span
                  aria-label={metric.valueText ?? `剩余 ${Math.round(metric.remainingPercent)}%`}
                  className={`shrink-0 whitespace-nowrap font-normal tabular-nums ${remainingColor}`}
                >
                  {metric.valueText ?? `${Math.round(metric.remainingPercent)}%`}
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2 tabular-nums">
                {resetLabel ? (
                  <span
                    aria-label={`${timeKind}：${resetLabel}`}
                    className="inline-flex min-w-0 items-center gap-1 font-normal text-muted"
                    title={resetTitle ?? resetLabel}
                  >
                    <span className="truncate">{resetLabel}</span>
                  </span>
                ) : null}
              </div>
            </div>
            {metric.hideProgress ? null : <div className="flex min-w-0 items-center gap-3">
              <ProgressBar
                aria-label={`${title} ${metric.group === 'image' ? '图片 ' : metric.group === 'video' ? '视频 ' : ''}${metric.label} ${metric.valueText ?? `剩余 ${Math.round(metric.remainingPercent)}%`}${resetLabel ? `，${timeKind}${resetLabel}` : ''}`}
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
                <ProgressBar.Track className="grid h-1 grid-cols-12 gap-0.5 rounded-none bg-transparent">
                  {Array.from({ length: 12 }, (_, index) => {
                    const fillPercent = Math.min(100, Math.max(0, metric.remainingPercent * 12 - index * 100));
                    return (
                      <span aria-hidden="true" className="h-full overflow-hidden rounded-full bg-surface-secondary" key={index}>
                        <span
                          className={`block h-full rounded-full motion-safe:transition-[width,background-color] motion-safe:duration-300 motion-safe:ease-out ${fillColor}`}
                          style={{ width: `${fillPercent}%` }}
                        />
                      </span>
                    );
                  })}
                </ProgressBar.Track>
              </ProgressBar>
            </div>}
          </div>
        );
      })}
    </div>
  );
}

/** Format only provider-supplied reset timestamps; fetch time is intentionally excluded. */
export function formatSubscriptionResetTime(
  resetsAt?: number | null,
  now = new Date(),
  absolute = false,
): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const date = new Date(resetsAt * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  if (absolute) return format(date, 'M月d日 HH:mm');

  const daysUntilReset = differenceInCalendarDays(date, now);
  const dayLabel = daysUntilReset === 0
    ? '今日'
    : daysUntilReset === 1
      ? '明日'
      : daysUntilReset > 1
        ? `${daysUntilReset}d`
        : format(date, 'M月d日');
  return `${dayLabel} ${format(date, 'HH:mm')}`;
}

function formatSubscriptionDaysRemaining(resetsAt?: number | null, now = new Date()): string | null {
  const date = subscriptionTimestampToDate(resetsAt);
  if (!date) return null;
  const daysUntilExpiry = differenceInCalendarDays(date, now);
  if (daysUntilExpiry <= 0) return format(date, 'HH:mm');
  if (daysUntilExpiry === 1) return '明日';
  return `${daysUntilExpiry}d`;
}

function formatSubscriptionExpiryDate(resetsAt?: number | null): string | null {
  const date = subscriptionTimestampToDate(resetsAt);
  return date ? format(date, 'M月d日到期') : null;
}

function subscriptionTimestampToDate(timestamp?: number | null): Date | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp * 1_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function detailToneClass(tone?: 'success' | 'warning' | 'danger' | 'muted'): string {
  return tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-muted' : 'text-foreground';
}

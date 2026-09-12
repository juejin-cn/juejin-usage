import { useCallback, useEffect, useMemo, useState } from 'react';
import { Xmark } from '@gravity-ui/icons';
import { Button, Chip } from '@heroui/react';
import {
  DASHBOARD_RANGE_DAYS,
  DashboardFilter,
  type DashboardRange,
} from '@/components/DashboardFilter';
import { DashboardLoadingSkeleton } from '@/components/DashboardLoadingSkeleton';
import { DashboardOverviewCard } from '@/components/DashboardOverviewCard';
import { DashboardRangeSyncOverlay } from '@/components/DashboardRangeSyncOverlay';
import { DailyUsageTrendCard } from '@/components/DailyUsageTrendCard';
import { TokenUsageTrendCard } from '@/components/TokenUsageTrendCard';
// 分时热力图：暂时注释，保留组件便于以后恢复
// import { HourlyActivityHeatmap } from '@/components/HourlyActivityHeatmap';
import { StatusBanner } from '@/components/StatusBanner';
import { ProjectUsagePanel } from '@/components/ProjectUsagePanel';
import { ToolModelUsagePanel } from '@/components/ToolModelUsagePanel';
import { UsageDistributionCard } from '@/components/UsageDistributionCard';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { projectDashboardForDate } from '@/lib/dashboard-data';
import { scheduleAfterPaint } from '@/lib/schedule-after-paint';
import { DATA_SYNCED_EVENT } from '@/lib/shell-events';
import { localDateNow } from '@/lib/stats-timezone';
import { sourceLabel } from '@/lib/tokens';
import { useShareSnapshot } from '../../../../../packages/dashboard/src/hooks/ShareSnapshotContext';
import {
  buildToolModelDistributions,
  filterProjectRowsBySources,
  filterTrendRowsBySources,
} from '@/lib/usage-filter';
import { LOCAL_RUNTIME_RECOVERING_HINT } from '@/lib/api';
import {
  DASHBOARD_RANGE_LABELS,
  DEFAULT_DASHBOARD_RANGE,
  isDashboardRange,
} from '../../shared/dashboard-range';

/**
 * Tabs `range` updates immediately; data fetch waits until after paint so
 * selected background + label colors can commit without contending with I/O.
 */
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

/** HeroUI dashboard backed by the same usage dataset as the root route. */
export function DashboardPage() {
  const [range, setRange] = useLocalStorage<DashboardRange>(
    'tud.dashboardRange',
    DEFAULT_DASHBOARD_RANGE,
    isDashboardRange,
  );
  useEffect(() => {
    void window.tud.setDashboardRange(range);
  }, [range]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const { publishSnapshot } = useShareSnapshot();
  const dataRange = useDeferredDashboardRange(range);
  const rangeDays = DASHBOARD_RANGE_DAYS[dataRange];
  const { data, error, loading, refreshing, reload } =
    useDashboardData(rangeDays, selectedDate);
  const view = useMemo(
    () => (selectedDate ? projectDashboardForDate(data, selectedDate) : data),
    [data, selectedDate],
  );
  const dayScoped = selectedDate != null;
  const isHourly = dayScoped || rangeDays === 1;
  const shareRangeLabel = selectedDate
    ? formatFilterDayLabel(selectedDate)
    : DASHBOARD_RANGE_LABELS[range];
  const shareToolLabel = selectedTools.length > 0
    ? selectedTools.map(sourceLabel).join('、')
    : '全部工具';

  useEffect(() => {
    if (loading || refreshing) return;
    publishSnapshot({
      rangeLabel: shareRangeLabel,
      summary: view.summary,
      toolLabel: shareToolLabel,
    });
  }, [
    loading,
    publishSnapshot,
    refreshing,
    shareRangeLabel,
    shareToolLabel,
    view.summary,
  ]);

  useEffect(() => {
    const available = new Set(view.toolModelUsage.map((row) => row.source));
    setSelectedTools((current) => {
      const next = current.filter((source) => available.has(source));
      return next.length === current.length ? current : next;
    });
  }, [view.toolModelUsage]);

  useEffect(() => {
    let timer = 0;
    const onSynced = () => {
      // Hidden window: skip — the hook's focus/visibility probe catches up.
      if (document.visibilityState === 'hidden') return;
      // Coalesce bursts of sync events into a single reload.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => reload(), 250);
    };
    window.addEventListener(DATA_SYNCED_EVENT, onSynced);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(DATA_SYNCED_EVENT, onSynced);
    };
  }, [reload]);

  const handleRangeChange = (next: DashboardRange) => {
    if (next === range) return;
    setSelectedDate(null);
    setRange(next);
  };

  const visibleToolRows = useMemo(
    () => {
      if (selectedTools.length === 0) return view.toolModelUsage;
      const selected = new Set(selectedTools);
      return view.toolModelUsage.filter((row) => selected.has(row.source));
    },
    [selectedTools, view.toolModelUsage],
  );
  const visibleDistributions = useMemo(
    () => buildToolModelDistributions(visibleToolRows),
    [visibleToolRows],
  );
  const visibleTrendRows = useMemo(
    () =>
      filterTrendRowsBySources({
        dailyRows: view.rangeDailyUsage,
        hourlyRows: view.todayHourlyUsage,
        hourlyApiRows: data.hourlyApiRows,
        hourlyDate: selectedDate ?? (isHourly ? localDateNow() : undefined),
        heatmapDays: data.heatmapDays,
        modelRows: view.modelRows,
        toolRows: view.toolModelUsage,
        selectedSources: selectedTools,
      }),
    [
      data.heatmapDays,
      data.hourlyApiRows,
      isHourly,
      selectedDate,
      selectedTools,
      view.modelRows,
      view.rangeDailyUsage,
      view.todayHourlyUsage,
      view.toolModelUsage,
    ],
  );
  const visibleProjectRows = useMemo(
    () => filterProjectRowsBySources(view.projectModelUsage, selectedTools),
    [selectedTools, view.projectModelUsage],
  );
  // Stable identity so the memoized overview card / heatmap skip re-renders.
  const handleSelectDate = useCallback((date: string) => {
    setSelectedDate((current) => (current === date ? null : date));
  }, []);

  return (
    <div
      aria-busy={loading || refreshing}
      className="dashboard-page flex w-full flex-col"
    >
      <DashboardFilter
        selectedTools={selectedTools}
        tools={view.toolModelUsage}
        value={range}
        onChange={handleRangeChange}
        onToolsChange={setSelectedTools}
      />

      {selectedDate && (
        <div className="mb-4">
          <Chip className="gap-1.5" size="sm" variant="soft">
            <Chip.Label>当前筛选：{formatFilterDayLabel(selectedDate)}</Chip.Label>
            <Button
              aria-label="清除日期筛选"
              className="h-5 min-w-0 gap-0.5 px-1.5 text-xs"
              size="sm"
              variant="ghost"
              onPress={() => setSelectedDate(null)}
            >
              <Xmark className="size-3.5" />
              清除
            </Button>
          </Chip>
        </div>
      )}

      {error && !loading && (
        <div className="mb-4">
          <StatusBanner
            description={
              error === LOCAL_RUNTIME_RECOVERING_HINT ? undefined : error
            }
            title={
              error === LOCAL_RUNTIME_RECOVERING_HINT
                ? LOCAL_RUNTIME_RECOVERING_HINT
                : '暂无用量数据'
            }
            tone="warn"
          />
        </div>
      )}

      {loading ? (
        <div className="relative isolate min-h-48">
          <DashboardRangeSyncOverlay visible />
          <DashboardLoadingSkeleton />
        </div>
      ) : (
        <div className="relative isolate min-h-48">
          <DashboardRangeSyncOverlay visible={refreshing} />
          <DashboardOverviewCard
            dailyUsage={data.dailyUsage}
            heatmapDays={data.heatmapDays}
            metricTrends={view.metricTrends}
            modelRows={data.modelRows}
            onSelectDate={handleSelectDate}
            selectedDate={selectedDate}
            summary={view.summary}
          />

          <section
            aria-label="用量图表"
            className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2"
          >
            <TokenUsageTrendCard
              dailyRows={visibleTrendRows.dailyRows}
              dayScoped={dayScoped}
              hourly={isHourly}
              hourlyRows={visibleTrendRows.hourlyRows}
            />
            <DailyUsageTrendCard
              dayScoped={dayScoped}
              hourly={isHourly}
              hourlyRows={visibleTrendRows.hourlyRows}
              rangeDays={DASHBOARD_RANGE_DAYS[range]}
              rows={visibleTrendRows.dailyRows}
            />
            {/* 分时活跃热力图：按天热力图已并入概览大卡片，此处注释便于以后恢复
            <HourlyActivityHeatmap rows={data.hourlyUsage} />
            */}
            <ToolModelUsagePanel rows={visibleToolRows} />
            <ProjectUsagePanel rows={visibleProjectRows} />
            {/* 终端分布：暂无真实 API，先隐藏 mock 占位
            <UsageDistributionCard
              description="按编辑器与终端来源查看用量占比"
              rows={distributions.terminals}
              title="终端分布"
            />
            */}
            <UsageDistributionCard
              description="按编程工具与 Agent 查看用量占比"
              rows={visibleDistributions.tools}
              title="工具分布"
            />
            <UsageDistributionCard
              description="按模型查看 Token 与费用占比"
              rows={visibleDistributions.models}
              title="模型分布"
            />
          </section>
        </div>
      )}
    </div>
  );
}

/** `YYYY-MM-DD` → `X月X日` (UTC calendar parts, same as heatmap cells). */
function formatFilterDayLabel(date: string): string {
  const [, month = '1', day = '1'] = date.slice(0, 10).split('-');
  return `${Number(month)}月${Number(day)}日`;
}

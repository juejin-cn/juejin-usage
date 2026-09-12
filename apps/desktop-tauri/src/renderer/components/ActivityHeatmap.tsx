import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ProviderIcon } from '@/components/ProviderIcon';
import type { DailyUsageRow, ModelBreakdownRow } from '@/lib/api';
import {
  buildActivityHeatmap,
  buildMonthMarkers,
  type HeatmapCell,
} from '@/lib/activity-heatmap';
import { parseDailyModelKey } from '@juejin-opensource/jusage-core/daily-model-key';
import { buildModelSourceMap } from '@/lib/chart-data';
import type { DashboardToolUsageRow } from '@/lib/dashboard-mock-data';
import { formatTokens, formatTokensExact } from '@/lib/format';
import {
  HEATMAP_STOPS_LIGHT,
  sourceLabel,
} from '@/lib/tokens';
import {
  buildModelSourceFallback,
  collectPlatformSources,
  computeModelRowsShare,
  filterDayModelsBySources,
  filterShareForDay,
  resolveActiveKeys,
  sourceInSet,
} from '@/lib/usage-filter';

/**
 * Min cell size. Narrow: keep this size and trim older weeks.
 * Wide: show all weeks and grow cells to fill the container.
 */
const DEFAULT_CELL_SIZE = 15;
const CELL_GAP = 4;
const LABEL_WIDTH = 20;
/** ~full year so the grid spans like BoardUI activity chart. */
const HEATMAP_WEEKS = 52;

const TOOLTIP_HIDE_DELAY_MS = 80;
/** Approximate max tooltip height — flip below the cell when space above is short. */
const TOOLTIP_FLIP_THRESHOLD_PX = 340;
/** Half of the tooltip width (`w-72` = 288px) plus a small margin. */
const TOOLTIP_HALF_WIDTH_PX = 156;

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTH_LABELS = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
];

interface ActivityHeatmapProps {
  days: DailyUsageRow[];
  /** 30-day model breakdown — used to map model → primary Agent in tooltip. */
  models?: ModelBreakdownRow[];
  /** Platform list for the source filter. */
  toolRows?: DashboardToolUsageRow[];
  /** Render grid only — parent card owns title/chrome. */
  embedded?: boolean;
  /** Controlled platform filter; `null` = 全部. */
  selectedSources?: string[] | null;
  /** Currently selected YYYY-MM-DD (UTC). */
  selectedDate?: string | null;
  /** Fired when a day cell is clicked. */
  onSelectDate?: (date: string) => void;
}

function cellSizeForWeeks(width: number, weeks: number) {
  const gaps = Math.max(0, weeks - 1) * CELL_GAP;
  const available = Math.max(0, width - LABEL_WIDTH - gaps);
  return Math.max(1, Math.floor(available / weeks) || 1);
}

function useResponsiveHeatmap(maxWeeks: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(DEFAULT_CELL_SIZE);
  const [visibleWeeks, setVisibleWeeks] = useState(maxWeeks);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || maxWeeks <= 0) return;

    const update = () => {
      const width = el.clientWidth;
      // How many weeks fit at the minimum cell size?
      const fitted = Math.floor(
        (width - LABEL_WIDTH + CELL_GAP) / (DEFAULT_CELL_SIZE + CELL_GAP),
      );
      const weeks = Math.max(1, Math.min(maxWeeks, fitted || 1));

      if (weeks >= maxWeeks) {
        // Full history fits — grow cells to fill width.
        setVisibleWeeks(maxWeeks);
        setCellSize(cellSizeForWeeks(width, maxWeeks));
      } else {
        // Too narrow — keep min cell size, drop older weeks.
        setVisibleWeeks(weeks);
        setCellSize(DEFAULT_CELL_SIZE);
      }
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [maxWeeks]);

  return { containerRef, cellSize, visibleWeeks };
}

function HeatmapTooltipContent({
  cell,
  heatmapColors,
  modelEntries,
  isLoading,
}: {
  cell: HeatmapCell;
  heatmapColors: readonly string[];
  modelEntries: TooltipModelEntry[];
  isLoading: boolean;
}) {
  const shown = modelEntries;

  return (
    <div className="grid min-w-0 gap-2 text-xs">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-foreground">{cell.day}</span>
        <span className="text-[10px] text-muted">等级 {cell.level}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: heatmapColors[cell.level] }}
        />
        <span className="flex-1 text-muted">总用量</span>
        <span
          className="font-mono font-medium tabular-nums text-foreground"
          title={formatTokensExact(cell.value)}
        >
          {formatTokens(cell.value)}
        </span>
      </div>

      {isLoading ? (
        <div aria-label="正在加载模型明细" className="grid gap-2 pt-0.5">
          <span className="h-2.5 w-14 animate-pulse rounded bg-surface-secondary" />
          <span className="h-3 w-full animate-pulse rounded bg-surface-secondary" />
          <span className="h-1 w-full animate-pulse rounded bg-surface-secondary" />
        </div>
      ) : shown.length > 0 ? (
        <div className="grid gap-2">
          <span className="text-[10px] font-medium text-muted">模型明细</span>
          {shown.map(({ key, name, source, val }) => {
            const total = cell.value || 1;
            const pct = Math.round((val / total) * 100);
            const displayName = source ? `${sourceLabel(source)} · ${name}` : name;
            return (
              <div key={key} className="grid min-w-0 gap-1">
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    {source && (
                      <ProviderIcon className="shrink-0" provider={source} size={12} />
                    )}
                    <span className="truncate" title={displayName}>
                      {displayName}
                    </span>
                  </span>
                  <span
                    className="whitespace-nowrap font-mono text-muted tabular-nums"
                    title={formatTokensExact(val)}
                  >
                    {formatTokens(val)} · {pct}%
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-surface-secondary">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

interface TooltipModelEntry {
  key: string;
  name: string;
  source?: string;
  val: number;
}

/** Calculate model details only after a tooltip has opened for one day. */
function buildTooltipModelEntries(
  cell: HeatmapCell,
  modelSources: Map<string, string>,
  sourceFilterSet: Set<string> | null,
): TooltipModelEntry[] {
  const ranked = Object.entries(cell.models ?? {})
    .map(([key, val]) => {
      const parsed = parseDailyModelKey(key);
      const source = parsed.source ?? modelSources.get(parsed.model);
      return { key, name: parsed.model, source, val };
    })
    .filter(({ val, source }) => {
      if (val <= 0) return false;
      if (!sourceFilterSet) return true;
      return source ? sourceInSet(source, sourceFilterSet) : false;
    })
    .sort((a, b) => b.val - a.val);
  const shown = ranked.slice(0, 6);
  const seen = new Set(shown.map((entry) => entry.source).filter(Boolean));
  for (const entry of ranked.slice(6)) {
    if (entry.source && !seen.has(entry.source)) {
      shown.push(entry);
      seen.add(entry.source);
    }
  }
  return shown;
}

/**
 * The 364-cell grid rendered as plain buttons — memoized so the shared
 * tooltip's hover state does not re-render every cell. Tooltips are handled
 * by the parent via event delegation on this container.
 */
const HeatmapCellsGrid = memo(function HeatmapCellsGrid({
  visible,
  cellSize,
  selectedDate,
  onSelectDate,
  onPointerOver,
  onPointerLeave,
  onFocus,
  onBlur,
}: {
  visible: Array<Array<HeatmapCell | null>>;
  cellSize: number;
  selectedDate: string | null;
  onSelectDate?: (date: string) => void;
  onPointerOver: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  onFocus: (event: ReactFocusEvent<HTMLDivElement>) => void;
  onBlur: () => void;
}) {
  return (
    <div
      style={{
        gridColumn: '2 / -1',
        display: 'grid',
        gridAutoFlow: 'column',
        gridTemplateRows: `repeat(7, ${cellSize}px)`,
        gridTemplateColumns: `repeat(${visible.length}, ${cellSize}px)`,
        gap: CELL_GAP,
      }}
      onBlur={onBlur}
      onFocus={onFocus}
      onPointerLeave={onPointerLeave}
      onPointerOver={onPointerOver}
    >
      {visible.map((week, wi) =>
        week.map((cell, di) => {
          if (!cell) return null;
          const color =
            HEATMAP_STOPS_LIGHT[cell.level] ?? HEATMAP_STOPS_LIGHT[0];
          const isSelected = selectedDate === cell.day;
          return (
            <button
              aria-label={`${cell.day}，${formatTokensExact(cell.value)} Token`}
              aria-pressed={onSelectDate ? isSelected : undefined}
              className={
                isSelected
                  ? 'block cursor-pointer rounded-[4px] ring-2 ring-accent/70 ring-offset-1 ring-offset-surface transition-[transform,background-color] duration-100 hover:scale-110'
                  : 'block cursor-pointer rounded-[4px] transition-[transform,background-color] duration-100 hover:scale-110'
              }
              data-day-index={di}
              data-day={cell.day}
              data-week-index={wi}
              key={cell.day || `e-${wi}-${di}`}
              style={{ width: cellSize, height: cellSize, background: color }}
              type="button"
              onClick={() => onSelectDate?.(cell.day)}
            />
          );
        }),
      )}
    </div>
  );
});

interface TooltipAnchor {
  day: string;
  cell: HeatmapCell;
  /** Viewport coordinates of the anchored cell. */
  left: number;
  top: number;
  bottom: number;
}

export const ActivityHeatmap = memo(function ActivityHeatmap({
  days,
  models = [],
  toolRows = [],
  embedded = false,
  selectedSources: selectedSourcesProp,
  selectedDate = null,
  onSelectDate,
}: ActivityHeatmapProps) {
  /** Uncontrolled fallback when parent does not own the filter. */
  const [internalSources] = useState<string[] | null>(null);
  const selectedSources = selectedSourcesProp ?? internalSources;

  const modelSources = useMemo(() => buildModelSourceMap(models), [models]);
  const allSources = useMemo(
    () => collectPlatformSources(toolRows, models),
    [models, toolRows],
  );
  const activeSources = useMemo(
    () => resolveActiveKeys(allSources, selectedSources),
    [allSources, selectedSources],
  );
  const sourceFallback = useMemo(
    () => buildModelSourceFallback(models),
    [models],
  );
  const rangeFilterShare = useMemo(
    () =>
      computeModelRowsShare(models, selectedSources, null, {
        activeSources,
        activeModels: [],
      }),
    [activeSources, models, selectedSources],
  );

  const filteredDays = useMemo(() => {
    if (selectedSources == null) return days;
    return days.map((day) => {
      const modelsMap = day.models ?? {};
      const share = filterShareForDay(modelsMap, selectedSources, null, {
        activeSources,
        activeModels: [],
        sourceFallback,
        fallbackShare: rangeFilterShare,
      });
      const filteredModels = filterDayModelsBySources(modelsMap, selectedSources, {
        activeSources,
        sourceFallback,
      });
      return {
        ...day,
        tokens: Math.round(day.tokens * share),
        costUsd: day.costUsd * share,
        models: filteredModels,
      };
    });
  }, [
    activeSources,
    days,
    rangeFilterShare,
    selectedSources,
    sourceFallback,
  ]);

  const heatmap = useMemo(
    () =>
      buildActivityHeatmap(
        filteredDays.map((d) => ({
          date: d.date,
          tokens: d.tokens,
          models: d.models,
        })),
        HEATMAP_WEEKS,
      ),
    [filteredDays],
  );

  const weeks = heatmap.weeks;
  const { containerRef, cellSize, visibleWeeks } = useResponsiveHeatmap(
    weeks.length || HEATMAP_WEEKS,
  );
  const visible = useMemo(
    () => weeks.slice(-visibleWeeks),
    [weeks, visibleWeeks],
  );
  const heatmapColors = HEATMAP_STOPS_LIGHT;

  const monthMarkers = useMemo(
    () => buildMonthMarkers(visible.length, heatmap.to, MONTH_LABELS),
    [visible.length, heatmap.to],
  );

  // Single shared tooltip for the whole grid (was: one HeroUI Tooltip per
  // cell, ~364 component trees rebuilt on every data refresh).
  const [tooltip, setTooltip] = useState<TooltipAnchor | null>(null);
  const tooltipRef = useRef<TooltipAnchor | null>(null);
  const hideTimerRef = useRef(0);

  const updateTooltip = useCallback((next: TooltipAnchor | null) => {
    tooltipRef.current = next;
    setTooltip(next);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const showTooltipFor = useCallback(
    (target: HTMLElement) => {
      const day = target.dataset.day;
      const weekIndex = Number(target.dataset.weekIndex);
      const dayIndex = Number(target.dataset.dayIndex);
      const cell = visible[weekIndex]?.[dayIndex];
      if (!day || !cell) return;
      window.clearTimeout(hideTimerRef.current);
      if (tooltipRef.current?.day === day) return;
      if (!target.isConnected) return;
      const rect = target.getBoundingClientRect();
      updateTooltip({
        day,
        cell,
        left: rect.left + rect.width / 2,
        top: rect.top,
        bottom: rect.bottom,
      });
    },
    [updateTooltip, visible],
  );

  const scheduleHideTooltip = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(
      () => updateTooltip(null),
      TOOLTIP_HIDE_DELAY_MS,
    );
  }, [updateTooltip]);

  const handleGridPointerOver = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-day]',
      );
      if (target) showTooltipFor(target);
    },
    [showTooltipFor],
  );

  const handleGridFocus = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-day]',
      );
      if (target) showTooltipFor(target);
    },
    [showTooltipFor],
  );

  const tooltipOpen = tooltip != null;
  useEffect(() => {
    if (!tooltipOpen) return;
    const onScroll = () => updateTooltip(null);
    window.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      window.removeEventListener('scroll', onScroll, { capture: true });
  }, [tooltipOpen, updateTooltip]);

  const weekColTemplate = `${LABEL_WIDTH}px repeat(${visible.length}, ${cellSize}px)`;
  const sourceFilterSet = useMemo(
    () => (selectedSources == null ? null : new Set(activeSources)),
    [activeSources, selectedSources],
  );

  const tooltipCell = tooltip?.cell ?? null;
  const [tooltipDetails, setTooltipDetails] = useState<{
    day: string;
    entries: TooltipModelEntry[];
  } | null>(null);

  useEffect(() => {
    if (!tooltipCell) {
      setTooltipDetails(null);
      return;
    }

    setTooltipDetails(null);
    const frame = window.requestAnimationFrame(() => {
      setTooltipDetails({
        day: tooltipCell.day,
        entries: buildTooltipModelEntries(
          tooltipCell,
          modelSources,
          sourceFilterSet,
        ),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [modelSources, sourceFilterSet, tooltipCell]);

  if (!weeks.length) {
    return (
      <div className="w-full py-8 text-center text-sm text-muted">
        暂无用量数据
      </div>
    );
  }

  let tooltipNode: ReactNode = null;
  if (tooltip && tooltipCell) {
    const placeBelow = tooltip.top < TOOLTIP_FLIP_THRESHOLD_PX;
    const clampedLeft = Math.min(
      Math.max(tooltip.left, TOOLTIP_HALF_WIDTH_PX),
      Math.max(TOOLTIP_HALF_WIDTH_PX, window.innerWidth - TOOLTIP_HALF_WIDTH_PX),
    );
    tooltipNode = createPortal(
      <div
        className="pointer-events-none fixed z-50 w-72 max-w-[calc(100vw-24px)] rounded-[10px] bg-overlay p-3 text-overlay-foreground shadow-surface"
        role="tooltip"
        style={{
          left: clampedLeft,
          top: placeBelow ? tooltip.bottom + 8 : tooltip.top - 8,
          transform: placeBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
        }}
      >
        <HeatmapTooltipContent
          cell={tooltipCell}
          heatmapColors={heatmapColors}
          isLoading={tooltipDetails?.day !== tooltipCell.day}
          modelEntries={
            tooltipDetails?.day === tooltipCell.day ? tooltipDetails.entries : []
          }
        />
      </div>,
      document.body,
    );
  }

  const grid = (
    <div ref={containerRef} className="w-full min-w-0">
      {selectedSources != null && activeSources.length === 0 ? (
        <div className="w-full py-8 text-center text-sm text-muted">
          请至少选择一个平台
        </div>
      ) : (
        <>
      <div className="w-full overflow-hidden">
        <div className="w-full min-w-0">
            <div
              className="mb-1.5 text-[10px] font-medium text-muted"
              style={{
                display: 'grid',
                gridTemplateColumns: weekColTemplate,
                columnGap: CELL_GAP,
              }}
            >
              <span />
              {monthMarkers.map((m) => (
                <span
                  key={`${m.label}-${m.index}`}
                  style={{ gridColumnStart: m.index + 2, whiteSpace: 'nowrap' }}
                >
                  {m.label}
                </span>
              ))}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: weekColTemplate,
                columnGap: CELL_GAP,
              }}
            >
              <div
                className="pr-1 text-[10px] font-medium text-muted"
                style={{
                  display: 'grid',
                  gridTemplateRows: `repeat(7, ${cellSize}px)`,
                  rowGap: CELL_GAP,
                }}
              >
                {DAY_LABELS.map((l) => (
                  <span key={l} className="flex items-center" style={{ lineHeight: 1 }}>
                    {l}
                  </span>
                ))}
              </div>

              <HeatmapCellsGrid
                cellSize={cellSize}
                onBlur={scheduleHideTooltip}
                onFocus={handleGridFocus}
                onPointerLeave={scheduleHideTooltip}
                onPointerOver={handleGridPointerOver}
                onSelectDate={onSelectDate}
                selectedDate={selectedDate}
                visible={visible}
              />
            </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <div aria-label="用量强度" className="flex items-center gap-1.5">
          <div className="flex gap-1">
            {heatmapColors.map((c, i) => (
              <span
                key={i}
                aria-label={`强度 ${i}`}
                className="size-3 rounded-[3px] border border-black/5"
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
      </div>
        </>
      )}

      {tooltipNode}
    </div>
  );

  if (embedded) return grid;

  return (
    <div className="w-full rounded-[16px] border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      {grid}
    </div>
  );
});

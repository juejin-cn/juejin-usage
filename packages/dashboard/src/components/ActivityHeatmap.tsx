import { cn } from '@/lib/utils';
import { Card } from '@heroui/react';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ProviderIcon } from '@/components/ProviderIcon';
import {
  applyPlatformFilterChange,
  PlatformFilterSelect,
} from '@/components/PlatformFilterSelect';
import { ResolvedThemeContext } from '@/hooks/resolved-theme';
import { getTauriDesktopBridge } from '@/lib/tauri-desktop';
import type { DailyUsageRow, ModelBreakdownRow } from '@/lib/api';
import {
  ACTIVITY_HEATMAP_LAYOUT,
  getActivityHeatmapLayout,
  buildActivityHeatmap,
  buildMonthMarkers,
  getTimezoneLabel,
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
const {
  minCellSize: DEFAULT_CELL_SIZE,
  gap: CELL_GAP,
  labelWidth: LABEL_WIDTH,
  edgePadding: EDGE_PADDING,
} = ACTIVITY_HEATMAP_LAYOUT;
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
  edgePadding?: number;
  /** Hide built-in platform filter (parent renders it). */
  hidePlatformFilter?: boolean;
  hideLegend?: boolean;
  hideAxisLabels?: boolean;
  animated?: boolean;
  /** Controlled platform filter; `null` = 全部. */
  selectedSources?: string[] | null;
  onSelectedSourcesChange?: (next: string[] | null) => void;
  /** Currently selected YYYY-MM-DD (UTC). */
  selectedDate?: string | null;
  /** Fired when a day cell is clicked. */
  onSelectDate?: (date: string) => void;
  /** Custom tooltip content renderer (e.g. Web Popover-style composition). */
  renderTooltip?: (props: HeatmapTooltipRenderProps) => ReactNode;
  /** Positioning wrapper classes (width / z-index / max-width). */
  tooltipClassName?: string;
  /** Inner card surface classes (radius / background / shadow / padding). */
  tooltipSurfaceClassName?: string;
  /** Half width + viewport margin for horizontal clamping. */
  tooltipHalfWidth?: number;
  /** Clearance above cell required before flipping below. */
  tooltipFlipThreshold?: number;
}

function useResponsiveHeatmap(maxWeeks: number, showWeekdays: boolean, edgePadding: number) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState<number>(DEFAULT_CELL_SIZE);
  const [visibleWeeks, setVisibleWeeks] = useState(maxWeeks);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || maxWeeks <= 0) return;

    const update = () => {
      const next = getActivityHeatmapLayout(el.clientWidth, maxWeeks, showWeekdays, edgePadding);
      setVisibleWeeks(next.visibleWeeks);
      setCellSize(next.cellSize);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [maxWeeks, showWeekdays, edgePadding]);

  return { containerRef, cellSize, visibleWeeks };
}

function HeatmapTooltipContent({
  cell,
  heatmapColors,
  modelEntries,
}: {
  cell: HeatmapCell;
  heatmapColors: readonly string[];
  modelEntries: TooltipModelEntry[];
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

      {shown.length > 0 ? (
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

export interface TooltipModelEntry {
  key: string;
  name: string;
  source?: string;
  val: number;
}

export interface HeatmapTooltipRenderProps {
  cell: HeatmapCell;
  heatmapColors: readonly string[];
  modelEntries: TooltipModelEntry[];
  allModelEntries: TooltipModelEntry[];
}

function rankTooltipModelEntries(
  cell: HeatmapCell,
  modelSources: Map<string, string>,
  sourceFilterSet: Set<string> | null,
): TooltipModelEntry[] {
  return Object.entries(cell.models ?? {})
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
}

function selectTooltipModelEntries(ranked: TooltipModelEntry[]): TooltipModelEntry[] {
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
 * Keep the year-sized cell grid out of the tooltip render path. A single
 * delegated listener updates one shared tooltip instead of mounting an
 * overlay component (and its model detail tree) for every day.
 */
const HeatmapCellsGrid = memo(function HeatmapCellsGrid({
  animated,
  visible,
  cellSize,
  selectedDate,
  onSelectDate,
  onPointerOver,
  onPointerLeave,
  onFocus,
  onBlur,
}: {
  animated: boolean;
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
      className={animated ? 'usage-heatmap-motion' : undefined}
      style={{
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
              style={{
                width: cellSize, height: cellSize, background: color,
                ...(animated && { '--week': wi, '--weekday': di }),
              } as CSSProperties}
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

export function ActivityHeatmap({
  days,
  models = [],
  toolRows = [],
  embedded = false,
  edgePadding = EDGE_PADDING,
  hidePlatformFilter = false,
  hideLegend = false,
  hideAxisLabels = false,
  animated = false,
  selectedSources: selectedSourcesProp,
  onSelectedSourcesChange,
  selectedDate = null,
  onSelectDate,
  renderTooltip,
  tooltipClassName,
  tooltipSurfaceClassName,
  tooltipHalfWidth = TOOLTIP_HALF_WIDTH_PX,
  tooltipFlipThreshold = TOOLTIP_FLIP_THRESHOLD_PX,
}: ActivityHeatmapProps) {
  const tauriDesktop = Boolean(getTauriDesktopBridge());
  const theme = useContext(ResolvedThemeContext);
  /** Uncontrolled fallback when parent does not own the filter. */
  const [internalSources, setInternalSources] = useState<string[] | null>(
    null,
  );
  const selectedSources = selectedSourcesProp ?? internalSources;
  const setSelectedSources =
    onSelectedSourcesChange ?? setInternalSources;

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
          costUsd: d.costUsd,
          models: d.models,
        })),
        HEATMAP_WEEKS,
      ),
    [filteredDays],
  );

  const weeks = heatmap.weeks;
  const { containerRef, cellSize, visibleWeeks } = useResponsiveHeatmap(
    weeks.length || HEATMAP_WEEKS,
    !hideAxisLabels,
    edgePadding,
  );
  const visible = useMemo(
    () => weeks.slice(-visibleWeeks),
    [weeks, visibleWeeks],
  );
  const heatmapColors = HEATMAP_STOPS_LIGHT;
  void theme;

  const monthMarkers = useMemo(
    () => buildMonthMarkers(visible.length, heatmap.to, MONTH_LABELS),
    [visible.length, heatmap.to],
  );

  const [tooltip, setTooltip] = useState<TooltipAnchor | null>(null);
  const [tooltipClosing, setTooltipClosing] = useState(false);
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
      setTooltipClosing(false);
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
    hideTimerRef.current = window.setTimeout(() => {
      if (animated && tooltipRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setTooltipClosing(true);
        hideTimerRef.current = window.setTimeout(() => updateTooltip(null), 120);
      } else {
        updateTooltip(null);
      }
    }, TOOLTIP_HIDE_DELAY_MS);
  }, [animated, updateTooltip]);

  const handleGridPointerOver = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-day]',
      );
      if (!target) return;
      if (animated && event.pointerType !== 'touch') {
        event.currentTarget.style.setProperty('--hover-week', target.dataset.weekIndex!);
        event.currentTarget.style.setProperty('--hover-day', target.dataset.dayIndex!);
      }
      showTooltipFor(target);
    },
    [animated, showTooltipFor],
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
  const sourceSelectValue =
    selectedSources == null
      ? allSources
      : selectedSources.filter((source) => allSources.includes(source));
  const sourceFilterSet = useMemo(
    () => (selectedSources == null ? null : new Set(activeSources)),
    [activeSources, selectedSources],
  );

  const tooltipCell = tooltip?.cell ?? null;
  const tooltipModels = useMemo(() => {
    if (!tooltipCell) return { all: [] as TooltipModelEntry[], shown: [] as TooltipModelEntry[] };
    const all = rankTooltipModelEntries(tooltipCell, modelSources, sourceFilterSet);
    return { all, shown: selectTooltipModelEntries(all) };
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
    const spaceAbove = tooltip.top - 16;
    const spaceBelow = window.innerHeight - tooltip.bottom - 16;
    const placeBelow = spaceAbove < tooltipFlipThreshold && spaceBelow >= spaceAbove;
    const clampedLeft = Math.min(
      Math.max(tooltip.left, tooltipHalfWidth),
      Math.max(tooltipHalfWidth, window.innerWidth - tooltipHalfWidth),
    );
    tooltipNode = createPortal(
      <div
        className={cn(
          'pointer-events-none fixed',
          tooltipClassName ?? 'z-50 w-72 max-w-[calc(100vw-24px)]',
          animated && 'usage-heatmap-tooltip',
        )}
        data-closing={tooltipClosing || undefined}
        data-side={placeBelow ? 'bottom' : 'top'}
        role="tooltip"
        style={{
          left: clampedLeft,
          top: placeBelow ? tooltip.bottom + 8 : tooltip.top - 8,
          transform: placeBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
        }}
      >
        <div
          className={
            tooltipSurfaceClassName ??
            'rounded-[10px] bg-overlay p-3 text-overlay-foreground shadow-surface'
          }
        >
          {renderTooltip ? (
            renderTooltip({
              cell: tooltipCell,
              heatmapColors,
              modelEntries: tooltipModels.shown,
              allModelEntries: tooltipModels.all,
            })
          ) : (
            <HeatmapTooltipContent
              cell={tooltipCell}
              heatmapColors={heatmapColors}
              modelEntries={tooltipModels.shown}
            />
          )}
        </div>
      </div>,
      document.body,
    );
  }

  const grid = (
    <div ref={containerRef} className="w-full min-w-0">
      {!hidePlatformFilter || !embedded ? (
        <div className="mb-2 flex items-center justify-end gap-3">
          {!embedded ? (
            <span className="mr-auto text-xs text-muted">
              {getTimezoneLabel()}
            </span>
          ) : null}
          {!hidePlatformFilter ? (
            <PlatformFilterSelect
              allSources={allSources}
              value={sourceSelectValue}
              onChange={(keys) =>
                applyPlatformFilterChange(keys, allSources, setSelectedSources)
              }
            />
          ) : null}
        </div>
      ) : null}

      {selectedSources != null && activeSources.length === 0 ? (
        <div className="w-full py-8 text-center text-sm text-muted">
          请至少选择一个平台
        </div>
      ) : (
        <>
      <div className="w-full overflow-hidden" style={{ padding: edgePadding }}>
        <div className="w-full min-w-0">
            {!hideAxisLabels && <div
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
                  style={{
                    gridColumnStart: m.index + 2,
                    whiteSpace: 'nowrap',
                    justifySelf: m.index === visible.length - 1 ? 'end' : undefined,
                  }}
                >
                  {m.label}
                </span>
              ))}
            </div>}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: hideAxisLabels ? 'minmax(0, 1fr)' : `${LABEL_WIDTH}px minmax(0, 1fr)`,
                columnGap: CELL_GAP,
              }}
            >
              {!hideAxisLabels && <div
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
              </div>}

              <HeatmapCellsGrid
                animated={animated}
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

      {hideLegend ? null : tauriDesktop ? (
        <div className="mt-4 flex justify-end">
          <div aria-label="用量强度" className="flex items-center gap-1.5">
            {heatmapColors.map((color, index) => (
              <span key={index} aria-label={`强度 ${index}`}
                className="size-3 rounded-[3px] border border-black/5"
                style={{ background: color }} />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium text-muted">{getTimezoneLabel()}</span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted">少</span>
            <div className="flex gap-1">
              {heatmapColors.map((color, index) => (
                <span key={index} className="size-3 rounded-[2px]" style={{ background: color }} />
              ))}
            </div>
            <span className="text-[10px] text-muted">多</span>
          </div>
        </div>
      )}

      {tooltipNode}
        </>
      )}

    </div>
  );

  if (embedded) return grid;

  return (
    <Card><Card.Content>{grid}</Card.Content></Card>
  );
}

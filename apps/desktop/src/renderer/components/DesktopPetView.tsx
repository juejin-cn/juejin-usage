import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import { fetchDaily } from '@/lib/api';
import { formatTokens, formatTokensExact, formatUsd } from '@/lib/format';
import {
  buildPetSyncFeedback,
  type PetSyncFeedback,
  type PetUsageSnapshot,
} from '@/lib/pet-sync-feedback';
import { localDateDaysAgo, localDateNow } from '@/lib/stats-timezone';
import { getDesktopPet, loadPetSpritesheet } from '@/pets';
import {
  DASHBOARD_RANGE_DAYS,
  DASHBOARD_RANGE_LABELS,
  DEFAULT_DASHBOARD_RANGE,
  type DashboardRange,
} from '../../shared/dashboard-range';
import {
  DESKTOP_PET_SOURCE_HEIGHT,
  DESKTOP_PET_SOURCE_WIDTH,
  getDesktopPetLayout,
} from '../../shared/desktop-pet-layout';
import {
  PET_SPRITESHEET_HEIGHT,
  PET_SPRITESHEET_WIDTH,
  paintPetSpriteFrame,
  petSpriteCell,
  type PetAnimation,
} from '../../shared/desktop-pet-sprite';

const DISPLAY_SCALE = 0.5;
const DRAG_ANIMATION_SPEED_MULTIPLIER = 0.55;
const SYNC_FEEDBACK_DURATION_MS = 5_000;
const BUBBLE_GAP_PX = 8;

function calculateRangeTotals(
  rows: Array<{ date: string; tokens: number; costUsd: number }>,
  range: DashboardRange,
  today: string,
): {
  totalTokens: number;
  totalCostUsd: number;
} {
  const startDate = localDateDaysAgo(DASHBOARD_RANGE_DAYS[range]);
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const row of rows) {
    if (row.date < startDate || row.date > today) continue;
    totalTokens += row.tokens;
    totalCostUsd += row.costUsd;
  }
  return { totalTokens, totalCostUsd };
}

/** Transparent pet view with manual drag support so click can open its token bubble. */
export function DesktopPetView() {
  const [animation, setAnimation] = useState<PetAnimation>('idle');
  const [selectedPetId, setSelectedPetId] = useState('hawking');
  const [scale, setScale] = useState(DISPLAY_SCALE);
  const [frameIntervalMs, setFrameIntervalMs] = useState(180);
  const [isTokenTooltipOpen, setIsTokenTooltipOpen] = useState(false);
  const [range, setRange] = useState<DashboardRange>(DEFAULT_DASHBOARD_RANGE);
  const [summary, setSummary] = useState<{ totalTokens: number; totalCostUsd: number } | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<PetSyncFeedback | null>(null);
  const [spritesheetUrl, setSpritesheetUrl] = useState<string | null>(null);
  const spriteRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef(0);
  const alphaCanvas = useRef<HTMLCanvasElement | null>(null);
  const ignored = useRef(false);
  const usageSnapshot = useRef<PetUsageSnapshot | null>(null);
  const feedbackTimer = useRef<number | null>(null);
  const enqueueUsageRefresh = useRef<(announce: boolean) => void>(() => undefined);
  const dragState = useRef<{
    pointerId: number;
    screenX: number;
    screenY: number;
    moved: boolean;
  } | null>(null);
  const effectiveFrameIntervalMs = animation === 'idle'
    ? frameIntervalMs
    : Math.max(60, Math.round(frameIntervalMs * DRAG_ANIMATION_SPEED_MULTIPLIER));
  const layout = getDesktopPetLayout(scale);
  const { spriteWidth, spriteHeight } = layout;


  /**
   * Frame clock writes `backgroundPosition` on the sprite node. A React
   * setState loop would re-render the tree (and composite the transparent
   * window) on every idle cell, about 5–17 times a second.
   */
  useEffect(() => {
    const el = spriteRef.current;
    if (!el || !spritesheetUrl) return;
    const paint = () => {
      paintPetSpriteFrame(
        el,
        selectedPetId,
        animation,
        frameRef.current,
        spriteWidth,
        spriteHeight,
      );
    };
    paint();
    const timer = window.setInterval(() => {
      frameRef.current += 1;
      paint();
    }, effectiveFrameIntervalMs);
    return () => window.clearInterval(timer);
  }, [animation, selectedPetId, spritesheetUrl, spriteWidth, spriteHeight, effectiveFrameIntervalMs]);

  useEffect(() => window.tud.onDesktopPetAnimation(setAnimation), []);

  useEffect(() => {
    void window.tud.getDashboardRange().then(setRange);
    return window.tud.onDashboardRange(setRange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.tud.getDesktopPet().then((pref) => {
      if (cancelled) return;
      setScale(pref.scale);
      setFrameIntervalMs(pref.frameIntervalMs);
      setSelectedPetId(pref.selectedPetId);
    });
    const unsubscribe = window.tud.onDesktopPetPreferences((pref) => {
      setScale(pref.scale);
      setFrameIntervalMs(pref.frameIntervalMs);
      setSelectedPetId(pref.selectedPetId);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => { alphaCanvas.current = null; }, [selectedPetId]);

  // Load only the selected pet's atlas; unchosen spritesheets stay unloaded.
  useEffect(() => {
    let cancelled = false;
    setSpritesheetUrl(null);
    void loadPetSpritesheet(selectedPetId).then((url) => {
      if (!cancelled) setSpritesheetUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedPetId]);

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();

    const refreshUsage = async (announce: boolean) => {
      try {
        const daily = await fetchDaily(365);
        if (cancelled) return;

        const dailyRows = daily.days ?? [];
        const today = localDateNow();
        const nextSummary = calculateRangeTotals(dailyRows, range, today);
        const previous = usageSnapshot.current;
        const current: PetUsageSnapshot = {
          totalTokens: dailyRows.reduce(
            (total, row) => total + row.tokens,
            0,
          ),
          dailyRows,
        };
        usageSnapshot.current = current;
        setSummary({
          totalTokens: nextSummary.totalTokens,
          totalCostUsd: nextSummary.totalCostUsd,
        });
        setSummaryError(false);

        if (!announce || !previous) return;
        const feedback = buildPetSyncFeedback(
          previous,
          current,
          today,
        );
        // Dragging is an explicit interaction; never cover it with a broadcast.
        if (!feedback || dragState.current) return;

        if (feedbackTimer.current !== null) {
          window.clearTimeout(feedbackTimer.current);
        }
        setIsTokenTooltipOpen(false);
        setSyncFeedback(feedback);
        feedbackTimer.current = window.setTimeout(() => {
          feedbackTimer.current = null;
          setSyncFeedback(null);
        }, SYNC_FEEDBACK_DURATION_MS);
      } catch {
        // A failed celebration refresh must not replace the last good totals.
        if (!cancelled && usageSnapshot.current === null) setSummaryError(true);
      }
    };

    const enqueueRefresh = (announce: boolean) => {
      refreshQueue = refreshQueue.then(() => refreshUsage(announce));
    };

    enqueueUsageRefresh.current = enqueueRefresh;
    enqueueRefresh(false);
    const unsubscribe = window.tud.onDataSynced(() => enqueueRefresh(true));
    return () => {
      cancelled = true;
      enqueueUsageRefresh.current = () => undefined;
      unsubscribe();
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
        feedbackTimer.current = null;
      }
    };
  }, [range]);

  const setMouseIgnored = (shouldIgnore: boolean) => {
    if (shouldIgnore === ignored.current) return;
    ignored.current = shouldIgnore;
    window.tud.setDesktopPetMouseIgnored(shouldIgnore);
  };

  const loadAlphaMap = (image: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = PET_SPRITESHEET_WIDTH;
    canvas.height = PET_SPRITESHEET_HEIGHT;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    alphaCanvas.current = canvas;
  };

  const updateMousePassThrough = (event: MouseEvent<HTMLButtonElement>) => {
    if (dragState.current) {
      setMouseIgnored(false);
      return;
    }
    const canvas = alphaCanvas.current;
    if (!canvas) return;
    const cell = petSpriteCell(selectedPetId, animation, frameRef.current);
    const pointerX = Math.max(
      0,
      Math.min(DESKTOP_PET_SOURCE_WIDTH - 1, Math.floor(event.nativeEvent.offsetX / scale)),
    );
    const x = cell.mirrorX ? DESKTOP_PET_SOURCE_WIDTH - 1 - pointerX : pointerX;
    const y = Math.max(
      0,
      Math.min(DESKTOP_PET_SOURCE_HEIGHT - 1, Math.floor(event.nativeEvent.offsetY / scale)),
    );
    const alpha = canvas.getContext('2d', { willReadFrequently: true })
      ?.getImageData(cell.sourceX + x, cell.sourceY + y, 1, 1).data[3] ?? 0;
    setMouseIgnored(alpha < 16);
  };

  /**
   * Pointer-down hands the whole drag to main, which polls the OS cursor and
   * moves its own window. The renderer keeps tracking the pointer only to tell
   * a click apart from a drag, and never sends per-move coordinates.
   */
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // Right-click / macOS ctrl-click open the native menu; do not start a drag.
    if (event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    setMouseIgnored(false);
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
      feedbackTimer.current = null;
    }
    setSyncFeedback(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
      moved: false,
    };
    window.tud.beginDesktopPetDrag();
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.moved) return;
    if (
      Math.abs(event.screenX - drag.screenX) > 3
      || Math.abs(event.screenY - drag.screenY) > 3
    ) {
      drag.moved = true;
      setIsTokenTooltipOpen(false);
    }
  };

  const finishDrag = (
    event?: PointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const drag = dragState.current;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    dragState.current = null;
    window.tud.endDesktopPetDrag();
    setAnimation('idle');
    if (event && event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    if (!cancelled && !drag.moved) {
      if (usageSnapshot.current === null) {
        setSummaryError(false);
        enqueueUsageRefresh.current(false);
      }
      setIsTokenTooltipOpen((open) => !open);
    }
  };

  useEffect(() => {
    const cancelDrag = () => finishDrag(undefined, true);
    // Do not preventDefault: main shows the native menu from webContents `context-menu`.
    const onContextMenu = () => {
      setIsTokenTooltipOpen(false);
      setSyncFeedback(null);
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
        feedbackTimer.current = null;
      }
    };
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('contextmenu', onContextMenu);
      cancelDrag();
    };
  }, []);

  const pet = getDesktopPet(selectedPetId);
  const isBubbleOpen = isTokenTooltipOpen || syncFeedback !== null;

  return (
    <div
      className={
        window.tud?.platform === 'win32'
          ? 'desktop-pet-root desktop-pet-root--win'
          : 'desktop-pet-root'
      }
      onMouseMove={(event) => {
        if (!dragState.current && event.target === event.currentTarget) setMouseIgnored(true);
      }}
    >
      <img
        alt=""
        aria-hidden="true"
        className="desktop-pet-preload"
        src={spritesheetUrl ?? undefined}
        onLoad={(event) => loadAlphaMap(event.currentTarget)}
      />
      {isBubbleOpen ? (
        <div
          className="desktop-pet-bubble"
          onMouseEnter={() => setMouseIgnored(false)}
          style={{ width: layout.popoverWidth, bottom: spriteHeight + BUBBLE_GAP_PX }}
        >
          {syncFeedback ? (
            <PetSyncFeedbackContent feedback={syncFeedback} />
          ) : (
            <>
              <div className="desktop-pet-bubble-range">{DASHBOARD_RANGE_LABELS[range]}</div>
              <PetStatRow
                dotClassName="desktop-pet-stat-dot--token"
                exactLabel={summary ? formatTokensExact(summary.totalTokens) : undefined}
                format={formatTokens}
                label="Token"
                state={summaryError ? 'error' : summary === null ? 'loading' : 'ready'}
                value={summary?.totalTokens ?? 0}
              />
              <PetStatRow
                dotClassName="desktop-pet-stat-dot--cost"
                format={formatUsd}
                label="费用"
                state={summaryError ? 'error' : summary === null ? 'loading' : 'ready'}
                value={summary?.totalCostUsd ?? 0}
              />
            </>
          )}
          <span aria-hidden className="desktop-pet-bubble-arrow" />
        </div>
      ) : null}
      <div
        className="desktop-pet-stage"
        style={{
          width: spriteWidth,
          height: spriteHeight,
          left: layout.spriteLeft,
          top: layout.spriteTop,
          '--pet-glow-primary': pet.glow.primary,
          '--pet-glow-accent': pet.glow.accent,
        } as CSSProperties}
      >
        <button
          ref={spriteRef}
          aria-label={`${pet.displayName} 桌面宠物，点击查看总 Token，拖动可移动，右键打开菜单`}
          className="desktop-pet-sprite"
          onMouseMove={updateMousePassThrough}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onLostPointerCapture={(event) => finishDrag(event, true)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          style={{
            width: spriteWidth,
            height: spriteHeight,
            backgroundImage: spritesheetUrl ? `url(${spritesheetUrl})` : undefined,
            backgroundSize: `${PET_SPRITESHEET_WIDTH * scale}px ${PET_SPRITESHEET_HEIGHT * scale}px`,
          }}
          type="button"
        />
      </div>
    </div>
  );
}

/** Compact celebration content shown inside the pet's lightweight bubble. */
function PetSyncFeedbackContent({ feedback }: { feedback: PetSyncFeedback }) {
  const milestones = [
    feedback.isDailyRecord ? '🎉 今日新高' : null,
    feedback.activeStreakDays >= 2
      ? `🔥 连续使用 ${feedback.activeStreakDays} 天`
      : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <div
      aria-live="polite"
      className="desktop-pet-feedback"
      role="status"
    >
      <div className="desktop-pet-feedback-headline">
        <span
          aria-hidden
          className="desktop-pet-feedback-dot"
        />
        <span className="desktop-pet-feedback-text">
          +
          <strong
            className="desktop-pet-feedback-amount"
            title={formatTokensExact(feedback.addedTokens)}
          >
            {formatTokens(feedback.addedTokens)}
          </strong>{' '}
          Token
        </span>
      </div>
      {milestones.length > 0 && (
        <div className="desktop-pet-feedback-milestones">
          {milestones.map((milestone) => (
            <span key={milestone}>{milestone}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One bullet + label + rolling value row inside the pet bubble. */
function PetStatRow({
  dotClassName,
  exactLabel,
  format,
  label,
  state,
  value,
}: {
  dotClassName: string;
  exactLabel?: string;
  format: (value: number) => string;
  label: string;
  state: 'error' | 'loading' | 'ready';
  value: number;
}) {
  // Hold at 0 until data lands so the roll runs once, on the real value.
  const animatedValue = useAnimatedNumber(state === 'ready' ? value : 0);

  return (
    <div className="desktop-pet-stat">
      <span className="desktop-pet-stat-label">
        <span aria-hidden className={`desktop-pet-stat-dot ${dotClassName}`} />
        <span>{label}</span>
      </span>
      <span
        aria-label={exactLabel ? `${label} ${exactLabel}` : undefined}
        className="desktop-pet-stat-value"
        title={exactLabel}
      >
        {state === 'error' ? '--' : state === 'loading' ? '…' : format(animatedValue)}
      </span>
    </div>
  );
}

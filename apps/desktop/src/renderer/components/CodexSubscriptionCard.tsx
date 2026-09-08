import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Skeleton } from '@heroui/react';
import codexColorIcon from '@lobehub/icons-static-svg/icons/codex-color.svg';
import type {
  CodexSubscriptionSnapshot,
} from '../../shared/codex-subscription';
import { codexRemainingPercent } from '../../shared/codex-subscription';

const INITIAL_SNAPSHOT: CodexSubscriptionSnapshot = {
  status: 'unavailable',
  planLabel: null,
  fiveHour: null,
  weekly: null,
  message: null,
};
const RING_STEP = 5;

/** Compact local ChatGPT/Codex allowance summary for the macOS tray. */
export function CodexSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<CodexSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await window.tud.getCodexSubscription());
    } catch {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        message: '暂时无法读取 Codex 订阅信息',
      });
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const fiveHourRemaining = snapshot.fiveHour
    ? codexRemainingPercent(snapshot.fiveHour.usedPercent)
    : null;
  const weeklyRemaining = snapshot.weekly
    ? codexRemainingPercent(snapshot.weekly.usedPercent)
    : null;

  return (
    <Card className="min-w-0 overflow-hidden rounded-2xl px-3 py-2">
      <Card.Content className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-x-1 p-0">
        <div className="grid min-w-0 content-center gap-2.5">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <img
              alt=""
              aria-hidden
              className="size-5 shrink-0 object-contain"
              src={codexColorIcon}
            />
            <p className="min-w-0 truncate text-xs font-semibold text-foreground">
              Codex
            </p>
          </div>

          {loading ? (
            <div
              className="grid gap-2.5 pl-1"
              role="status"
              aria-label="正在读取 Codex 订阅限额"
            >
              <MetricSkeleton />
              <MetricSkeleton />
            </div>
          ) : snapshot.status === 'ready' && (snapshot.fiveHour || snapshot.weekly) ? (
            <div className="grid gap-2.5 pl-1">
              {fiveHourRemaining !== null ? (
                <RemainingMetric color="#7dcf00" label="5h" value={fiveHourRemaining} />
              ) : null}
              {weeklyRemaining !== null ? (
                <RemainingMetric color="#2b7eff" label="7d" value={weeklyRemaining} />
              ) : null}
            </div>
          ) : (
            <p className="truncate text-xs leading-4 text-muted">
              {snapshot.message ?? '暂时无法读取 Codex 订阅限额'}
            </p>
          )}
        </div>

        {loading ? (
          <Skeleton className="col-start-2 row-start-1 size-22 translate-x-2 self-center justify-self-end rounded-full" />
        ) : snapshot.status === 'ready' && (snapshot.fiveHour || snapshot.weekly) ? (
          <SubscriptionRings
            fiveHourRemaining={fiveHourRemaining}
            weeklyRemaining={weeklyRemaining}
          />
        ) : null}
      </Card.Content>
    </Card>
  );
}

function RemainingMetric({
  color,
  label,
  value,
}: {
  color: string;
  label: '5h' | '7d';
  value: number;
}) {
  return (
    <div className="flex min-w-0 items-center justify-start gap-1.5 text-xs font-medium leading-4">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-foreground">{label}</span>
        <span className="shrink-0 text-muted tabular-nums">{Math.round(value)}%</span>
      </span>
    </div>
  );
}

function SubscriptionRings({
  fiveHourRemaining,
  weeklyRemaining,
}: {
  fiveHourRemaining: number | null;
  weeklyRemaining: number | null;
}) {
  const description = [
    fiveHourRemaining === null ? null : `5H 剩余 ${Math.round(fiveHourRemaining)}%`,
    weeklyRemaining === null ? null : `7D 剩余 ${Math.round(weeklyRemaining)}%`,
  ].filter(Boolean).join('，');
  return (
    <svg
      aria-label={description}
      className="col-start-2 row-start-1 size-22 translate-x-2 self-center justify-self-end"
      role="img"
      viewBox="0 0 72 72"
    >
      {weeklyRemaining !== null ? (
        <Ring color="#2b7eff" radius={27} value={weeklyRemaining} />
      ) : null}
      {fiveHourRemaining !== null ? (
        <Ring color="#7dcf00" radius={17} value={fiveHourRemaining} />
      ) : null}
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

function MetricSkeleton() {
  return (
    <div className="flex h-4 items-center gap-1.5">
      <Skeleton className="size-2 rounded-full" />
      <Skeleton className="h-3 w-16 rounded-full" />
    </div>
  );
}

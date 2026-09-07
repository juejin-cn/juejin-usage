import { useCallback, useEffect, useState } from 'react';
import { ArrowsRotateRight } from '@gravity-ui/icons';
import { Button, Card, ProgressBar, Skeleton } from '@heroui/react';
import type {
  CodexRateLimitWindow,
  CodexSubscriptionSnapshot,
} from '../../shared/codex-subscription';

const INITIAL_SNAPSHOT: CodexSubscriptionSnapshot = {
  status: 'unavailable',
  planLabel: null,
  fiveHour: null,
  weekly: null,
  message: null,
};

/** Compact local ChatGPT/Codex allowance summary for the macOS tray. */
export function CodexSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<CodexSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await window.tud.getCodexSubscription());
    } catch {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        message: '暂时无法读取 Codex 订阅信息',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Card className="min-w-0 overflow-hidden rounded-2xl p-3">
      <Card.Content className="grid content-start gap-3 p-0">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs font-medium text-muted">
            Codex
          </p>
          <Button
            aria-label="刷新 Codex 订阅限额"
            className="size-6 min-w-6 shrink-0"
            isDisabled={loading}
            isIconOnly
            isPending={loading}
            onPress={reload}
            size="sm"
            variant="ghost"
          >
            <ArrowsRotateRight className="size-3" />
          </Button>
        </div>

        {loading ? (
          <div className="grid gap-1.5" role="status" aria-label="正在读取 Codex 订阅限额">
            <Skeleton className="h-2.5 w-full rounded-full" />
            <Skeleton className="h-2.5 w-full rounded-full" />
          </div>
        ) : snapshot.status === 'ready' ? (
          <div className="grid gap-1.5">
            <LimitRow label="5H" window={snapshot.fiveHour} />
            <LimitRow label="周" window={snapshot.weekly} />
          </div>
        ) : (
          <p className="text-xs leading-4 text-muted">暂不可用</p>
        )}
      </Card.Content>
    </Card>
  );
}

function LimitRow({ label, window }: { label: string; window: CodexRateLimitWindow | null }) {
  if (!window) {
    return <p className="text-xs text-muted">{label} —</p>;
  }
  const color = window.usedPercent >= 90 ? 'danger' : window.usedPercent >= 70 ? 'warning' : 'accent';
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px] leading-3">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted tabular-nums">{window.usedPercent}%</span>
      </div>
      <ProgressBar
        aria-label={`${label} 已用 ${window.usedPercent}%`}
        className="w-full"
        color={color}
        maxValue={100}
        size="sm"
        value={window.usedPercent}
      >
        <ProgressBar.Track className="h-1 rounded-full bg-surface-secondary">
          <ProgressBar.Fill className="rounded-full" />
        </ProgressBar.Track>
      </ProgressBar>
    </div>
  );
}

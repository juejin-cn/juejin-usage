import { codexSubscriptionDetails } from '../lib/codex-subscription-details';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { format } from 'date-fns';
import { PlayingCardsFan } from 'lucide-react';
import { codexRemainingPercent, type CodexSubscriptionSnapshot } from '../../shared/codex-subscription';
import {
  INITIAL_CODEX_SUBSCRIPTION_STATE,
  shouldRefreshCodexOnFocus,
  updateCodexSubscriptionState,
} from '../lib/codex-subscription-state';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { desktopMockCodexSubscription, isDesktopMockEnabled } from '../lib/desktop-subscription-mock';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const UNAVAILABLE_SNAPSHOT: CodexSubscriptionSnapshot = {
  status: 'unavailable',
  hasAccount: false,
  fetchedAt: null,
  stale: false,
  planLabel: null,
  fiveHour: null,
  weekly: null,
  message: '暂时无法读取 Codex 订阅额度，请稍后重试',
};

/** Compact local ChatGPT/Codex allowance summary for macOS desktop surfaces. */
export function CodexSubscriptionCard() {
  const [state, setState] = useState(INITIAL_CODEX_SUBSCRIPTION_STATE);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);
  const refreshOnFocus = useRef(true);
  const hasAccount = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (isDesktopMockEnabled()) {
      const next = desktopMockCodexSubscription();
      hasAccount.current = next.hasAccount;
      refreshOnFocus.current = false;
      setState((previous) => updateCodexSubscriptionState(previous, next, Date.now()));
      setLoading(false);
      return;
    }
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    let next: CodexSubscriptionSnapshot;
    try {
      next = await window.tud.getCodexSubscription({ forceRefresh });
    } catch {
      next = { ...UNAVAILABLE_SNAPSHOT, hasAccount: hasAccount.current };
    }
    hasAccount.current = next.hasAccount;
    refreshOnFocus.current = shouldRefreshCodexOnFocus(next);
    setState((previous) => updateCodexSubscriptionState(previous, next, Date.now()));
    requestInFlight.current = false;
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
    const onFocus = () => {
      if (refreshOnFocus.current) void reload();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const { snapshot, lastUpdatedAt } = state;
  if (!snapshot) return null;
  const failed = snapshot.message !== null;
  const stale = snapshot.stale;

  return (
    <SubscriptionUsageCard
      data={{
        detailRows: snapshot.fiveHour || snapshot.weekly || snapshot.credits || snapshot.resetCredits ? codexSubscriptionDetails(snapshot) : undefined,
        headerAccessory: snapshot.resetCredits ? (
          <span
            aria-label={`重置卡 ${snapshot.resetCredits.availableCount} 张`}
            title={`重置卡 ${snapshot.resetCredits.availableCount} 张`}
            className="inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full bg-default px-1.5 text-[11px] leading-4 tabular-nums text-muted"
          >
            <PlayingCardsFan aria-hidden="true" className="size-3" />
            x{snapshot.resetCredits.availableCount}
          </span>
        ) : undefined,
        icon: <SubscriptionBrandIcon brand="codex" />,
        metrics: [
          {
            color: '#7dcf00',
            label: '5h',
            remainingPercent: snapshot.fiveHour
              ? codexRemainingPercent(snapshot.fiveHour.usedPercent)
              : null,
            resetsAt: snapshot.fiveHour?.resetsAt,
          },
          {
            color: '#2b7eff',
            label: '7d',
            remainingPercent: snapshot.weekly
              ? codexRemainingPercent(snapshot.weekly.usedPercent)
              : null,
            resetsAt: snapshot.weekly?.resetsAt,
          },
        ],
        planLabel: snapshot.planLabel,
        hasAccount: snapshot.hasAccount,
        stale,
        title: 'Codex',
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
      feedback={failed ? (
        <div className="grid gap-2 text-xs leading-relaxed">
          <div className="grid gap-1" role="status">
            <p className="font-medium text-foreground">订阅额度暂不可用</p>
            <p className="break-words text-muted">{snapshot.message ?? UNAVAILABLE_SNAPSHOT.message}</p>
            {stale && lastUpdatedAt !== null ? (
              <p className="text-muted">
                显示上次额度，更新于 {format(lastUpdatedAt, 'M月d日 HH:mm')}
              </p>
            ) : null}
            <p className="text-muted">订阅额度与本地 Token 统计分开读取。</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">{shouldRefreshCodexOnFocus(snapshot) ? '窗口聚焦时自动重试' : '等待手动重试'}</span>
            <Button
              aria-label="重试读取 Codex 订阅额度"
              isDisabled={loading}
              isPending={loading}
              onPress={() => void reload(true)}
              size="sm"
              variant="outline"
            >
              {loading ? '重试中…' : '重试'}
            </Button>
          </div>
        </div>
      ) : null}
    />
  );
}

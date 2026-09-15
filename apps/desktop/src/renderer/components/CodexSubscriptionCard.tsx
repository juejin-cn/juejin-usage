import { useCallback, useEffect, useRef, useState } from 'react';
import {
  codexRemainingPercent,
  type CodexSubscriptionSnapshot,
} from '../../shared/codex-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

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

  return (
    <SubscriptionUsageCard
      data={{
        icon: <SubscriptionBrandIcon brand="codex" />,
        metrics: [
          {
            color: '#7dcf00',
            label: '5h',
            remainingPercent: snapshot.fiveHour
              ? codexRemainingPercent(snapshot.fiveHour.usedPercent)
              : null,
          },
          {
            color: '#2b7eff',
            label: '7d',
            remainingPercent: snapshot.weekly
              ? codexRemainingPercent(snapshot.weekly.usedPercent)
              : null,
          },
        ],
        planLabel: snapshot.planLabel,
        title: 'Codex',
      }}
      loading={loading}
    />
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claudeRemainingPercent,
  type ClaudeSubscriptionSnapshot,
} from '../../shared/claude-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: ClaudeSubscriptionSnapshot = {
  status: 'authorization-required',
  planLabel: null,
  fiveHour: null,
  sevenDay: null,
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Claude.ai allowance summary; failures intentionally collapse to an empty state. */
export function ClaudeSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<ClaudeSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await window.tud.getClaudeSubscription({
        allowCredentialAccess: true,
      }));
    } catch {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        status: 'temporarily-unavailable',
        message: '暂时无法读取 Claude 订阅信息',
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
        icon: <SubscriptionBrandIcon brand="claude" />,
        metrics: [
          {
            color: '#7dcf00',
            label: '5h',
            remainingPercent: snapshot.fiveHour
              ? claudeRemainingPercent(snapshot.fiveHour.usedPercent)
              : null,
          },
          {
            color: '#2b7eff',
            label: '7d',
            remainingPercent: snapshot.sevenDay
              ? claudeRemainingPercent(snapshot.sevenDay.usedPercent)
              : null,
          },
        ],
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title: 'Claude',
      }}
      loading={loading}
    />
  );
}

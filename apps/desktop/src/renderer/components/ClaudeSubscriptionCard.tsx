import { subscriptionDetails, subscriptionPoolKey } from '../lib/subscription-details';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claudeRemainingPercent,
  type ClaudeSubscriptionSnapshot,
} from '../../shared/claude-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { desktopMockClaudeSubscription, isDesktopMockEnabled } from '../lib/desktop-subscription-mock';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: ClaudeSubscriptionSnapshot = {
  status: 'authorization-required',
  planLabel: null,
  hasAccount: false,
  fiveHour: null,
  sevenDay: null,
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Claude Code allowance summary with actionable failures for signed-in accounts. */
export function ClaudeSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<ClaudeSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (isDesktopMockEnabled()) {
      setSnapshot(desktopMockClaudeSubscription());
      setLoading(false);
      return;
    }
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await window.tud.getClaudeSubscription({
        allowCredentialAccess: true,
        forceRefresh,
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
        details: subscriptionDetails(snapshot, 'Claude Code CLI', '重置时间'),
        icon: <SubscriptionBrandIcon brand="claude" />,
        metrics: [
          {
            color: '#7dcf00',
            poolKey: subscriptionPoolKey('Claude Code CLI', { label: '5h' }),
            label: '5h',
            remainingPercent: snapshot.fiveHour
              ? claudeRemainingPercent(snapshot.fiveHour.usedPercent)
              : null,
            resetsAt: snapshot.fiveHour?.resetsAt,
          },
          {
            color: '#2b7eff',
            poolKey: subscriptionPoolKey('Claude Code CLI', { label: '7d' }),
            label: '7d',
            remainingPercent: snapshot.sevenDay
              ? claudeRemainingPercent(snapshot.sevenDay.usedPercent)
              : null,
            resetsAt: snapshot.sevenDay?.resetsAt,
          },
        ],
        planLabel: snapshot.planLabel,
        hasAccount: snapshot.hasAccount,
        message: snapshot.message,
        stale: snapshot.stale,
        title: 'Claude',
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
    />
  );
}

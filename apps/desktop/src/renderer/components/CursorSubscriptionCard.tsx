import { subscriptionApi } from '../lib/subscription-api';
import { subscriptionDetails, subscriptionPoolKey } from '../lib/subscription-details';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cursorRemainingPercent,
  type CursorSubscriptionSnapshot,
} from '../../shared/cursor-subscription';
import { SubscriptionUsageCard, type SubscriptionUsageMetric } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: CursorSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  cursorModels: null,
  otherModels: null,
  plan: null,
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Cursor subscription pools from the locally signed-in desktop account. */
export function CursorSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<CursorSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await subscriptionApi.getCursorSubscription({ forceRefresh }));
    } catch {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        message: '暂时无法读取 Cursor 订阅信息',
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

  const metrics: SubscriptionUsageMetric[] = snapshot.plan
    ? [{
        color: '#2b7eff',
        poolKey: subscriptionPoolKey('Cursor Dashboard', { label: 'Plan' }),
        label: 'Plan',
        remainingPercent: cursorRemainingPercent(snapshot.plan.usedPercent),
        resetsAt: snapshot.plan.resetsAt,
      }]
    : [
        {
          color: '#7dcf00',
          poolKey: subscriptionPoolKey('Cursor Dashboard', { label: 'Auto' }),
          label: 'Auto',
          remainingPercent: snapshot.cursorModels
            ? cursorRemainingPercent(snapshot.cursorModels.usedPercent)
            : null,
          resetsAt: snapshot.cursorModels?.resetsAt,
        },
        {
          color: '#2b7eff',
          poolKey: subscriptionPoolKey('Cursor Dashboard', { label: 'API' }),
          label: 'API',
          remainingPercent: snapshot.otherModels
            ? cursorRemainingPercent(snapshot.otherModels.usedPercent)
            : null,
          resetsAt: snapshot.otherModels?.resetsAt,
        },
      ];

  if (snapshot.grokBot) metrics.push({
    poolKey: subscriptionPoolKey('Cursor Dashboard', { label: 'Grok Bot' }),
    color: '#2b7eff', label: 'Grok Bot',
    remainingPercent: cursorRemainingPercent(snapshot.grokBot.usedPercent),
    resetsAt: snapshot.grokBot.expiresAt ?? snapshot.grokBot.resetsAt,
    resetDisplay: snapshot.grokBot.expiresAt ? 'days-only' : 'date-time',
  });

  return (
    <SubscriptionUsageCard
      data={{
        details: subscriptionDetails(snapshot, 'Cursor Dashboard', '账期结束'),
        icon: <SubscriptionBrandIcon brand="cursor" />,
        metrics,
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title: 'Cursor',
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
    />
  );
}

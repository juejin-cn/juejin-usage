import { subscriptionApi } from '../lib/subscription-api';
import { subscriptionDetails, subscriptionPoolKey } from '../lib/subscription-details';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  grokRemainingPercent,
  type GrokSubscriptionSnapshot,
} from '@juejin-opensource/jusage-core/subscription/shared/grok-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: GrokSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Grok Build allowance read through the official CLI's cached login. */
export function GrokSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<GrokSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await subscriptionApi.getGrokSubscription({ forceRefresh }));
    } catch {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        message: '暂时无法读取 Grok 订阅信息',
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
        details: subscriptionDetails(snapshot, 'Grok Build CLI', '重置时间'),
        icon: <SubscriptionBrandIcon brand="grok" />,
        metrics: snapshot.limits.map((limit, index) => ({
          color: index === 0 && snapshot.limits.length > 1 ? '#7dcf00' : '#2b7eff',
          poolKey: subscriptionPoolKey('Grok Build CLI', limit),
          label: limit.label,
          remainingPercent: grokRemainingPercent(limit.usedPercent),
          resetsAt: limit.resetsAt,
        })),
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title: 'Grok',
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
    />
  );
}

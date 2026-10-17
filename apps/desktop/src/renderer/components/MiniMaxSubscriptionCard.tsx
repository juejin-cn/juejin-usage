import { subscriptionApi } from '../lib/subscription-api';
import { miniMaxProgressMetrics } from '../lib/subscription-progress';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MiniMaxSubscriptionSnapshot } from '../../shared/minimax-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: MiniMaxSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  region: null,
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Compact local MiniMax Code Coding Plan allowance summary for macOS desktop surfaces. */
export function MiniMaxSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<MiniMaxSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await subscriptionApi.getMiniMaxSubscription({ forceRefresh }));
    } catch {
      setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 MiniMax Code 订阅信息' });
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

  const title = snapshot.region === 'mainland'
    ? 'Minimax CN'
    : snapshot.region === 'global'
      ? 'Minimax'
      : 'Minimax';

  return (
    <SubscriptionUsageCard
      data={{
        icon: <SubscriptionBrandIcon brand="minimax" />,
        metrics: miniMaxProgressMetrics(snapshot),
        metricLimit: null,
        expandMetrics: true,
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title,
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
    />
  );
}

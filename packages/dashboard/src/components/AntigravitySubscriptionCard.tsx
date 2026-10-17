import { subscriptionApi } from '../lib/subscription-api';
import { geminiProgressMetrics } from '../lib/subscription-progress';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AntigravitySubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/antigravity-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: AntigravitySubscriptionSnapshot = {
  status: 'temporarily-unavailable', planLabel: null, limits: [], fetchedAt: null, stale: false, message: null,
};

/** Antigravity's official account model quota. */
export function AntigravitySubscriptionCard() {
  const [snapshot, setSnapshot] = useState<AntigravitySubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);
  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try { setSnapshot(await subscriptionApi.getAntigravitySubscription({ forceRefresh })); }
    catch { setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 Antigravity 订阅信息' }); }
    finally { requestInFlight.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  return <SubscriptionUsageCard data={{
    icon: <SubscriptionBrandIcon brand="antigravity" />,
    metrics: geminiProgressMetrics(snapshot),
    metricLimit: 3,
    expandMetrics: true,
    planLabel: snapshot.planLabel,
    stale: snapshot.stale,
    title: 'Gemini',
  }} onRefresh={() => void reload(true)} loading={loading} />;
}

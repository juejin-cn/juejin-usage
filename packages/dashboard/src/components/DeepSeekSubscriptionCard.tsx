import { subscriptionApi } from '../lib/subscription-api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DeepSeekSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/deepseek-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: DeepSeekSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

/**
 * Compact DeepSeek account balance summary for macOS desktop surfaces.
 *
 * DeepSeek reports a currency balance, not a quota percentage.
 */
export function DeepSeekSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<DeepSeekSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await subscriptionApi.getDeepSeekSubscription({ forceRefresh }));
    } catch {
      setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 DeepSeek 余额信息' });
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
        icon: <SubscriptionBrandIcon brand="deepseek" />,
        metrics: [],
        summaryRows: snapshot.limits.flatMap((balance) => [
          { label: '赠送余额', amount: balance.granted },
          { label: '充值余额', amount: balance.toppedUp },
        ].flatMap(({ label, amount }) => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
          ? [{ label, value: `¥${amount.toFixed(2)}` }] : [])),
        stale: snapshot.stale,
        hasAccount: snapshot.status === 'expired' || snapshot.status === 'temporarily-unavailable',
        message: snapshot.message,
        title: 'DeepSeek',
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
    />
  );
}

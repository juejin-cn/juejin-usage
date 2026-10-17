import { subscriptionApi } from '../lib/subscription-api';
import { qoderExpiryDetails, qoderProgressMetrics } from '../lib/subscription-progress';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  qoderSubscriptionHasAccount,
  type QoderSubscriptionSnapshot,
} from '../../shared/qoder-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: QoderSubscriptionSnapshot = {
  status: 'temporarily-unavailable', planLabel: null, limits: [], fetchedAt: null, stale: false, message: null,
};

/** Qoder's official logged-in account credits; BYOK values are excluded. */
export function QoderSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<QoderSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);
  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await subscriptionApi.getQoderSubscription({ forceRefresh }));
    }
    catch { setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 Qoder 订阅信息' }); }
    finally { requestInFlight.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  return <SubscriptionUsageCard data={{
    detailRows: qoderExpiryDetails(snapshot),
    hasAccount: qoderSubscriptionHasAccount(snapshot),
    icon: <SubscriptionBrandIcon brand="qoder" />,
    message: snapshot.message,
    metrics: qoderProgressMetrics(snapshot),
    metricLimit: null,
    planLabel: snapshot.planLabel,
    // Qoder may serve the official CLI's most recently synchronized credits;
    // keep the provider title stable instead of appending the generic stale tag.
    stale: false,
    title: 'Qoder',
  }} onRefresh={() => void reload(true)} loading={loading} />;
}

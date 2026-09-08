import { useCallback, useEffect, useRef, useState } from 'react';
import qoderIcon from '@lobehub/icons-static-svg/icons/qoder-color.svg';
import { qoderRemainingPercent, type QoderSubscriptionSnapshot } from '../../shared/qoder-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';

const INITIAL_SNAPSHOT: QoderSubscriptionSnapshot = {
  status: 'temporarily-unavailable', planLabel: null, limits: [], fetchedAt: null, stale: false, message: null,
};

/** Qoder's official logged-in account credits; BYOK values are excluded. */
export function QoderSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<QoderSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);
  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const qoderBridge = window.tud as typeof window.tud & {
        getQoderSubscription: () => Promise<QoderSubscriptionSnapshot>;
      };
      setSnapshot(await qoderBridge.getQoderSubscription());
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
    iconSrc: qoderIcon,
    metrics: snapshot.limits.map((limit, index) => ({
      color: index === 0 && snapshot.limits.length > 1 ? '#7dcf00' : '#2b7eff',
      label: limit.label,
      remainingPercent: qoderRemainingPercent(limit.usedPercent),
      ringRadius: index === 0 && snapshot.limits.length > 1 ? 17 : 27,
    })),
    // Qoder may serve the official CLI's most recently synchronized credits;
    // keep the provider title stable instead of appending the generic stale tag.
    stale: false,
    title: 'Qoder',
  }} loading={loading} />;
}

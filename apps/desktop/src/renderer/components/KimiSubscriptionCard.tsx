import { useCallback, useEffect, useRef, useState } from 'react';
import {
  kimiRemainingPercent,
  type KimiSubscriptionSnapshot,
} from '../../shared/kimi-subscription';
import { KimiSubscriptionBrandIcon } from './SubscriptionBrandIcon';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';

const INITIAL_SNAPSHOT: KimiSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Kimi Code's official OAuth subscription allowance. */
export function KimiSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<KimiSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await window.tud.getKimiSubscription());
    } catch {
      setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 Kimi Code 订阅信息' });
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
        icon: <KimiSubscriptionBrandIcon className="size-5" />,
        metrics: snapshot.limits.map((limit, index) => ({
          color: index === 0 && snapshot.limits.length > 1 ? '#7dcf00' : '#2b7eff',
          label: limit.label,
          remainingPercent: kimiRemainingPercent(limit.usedPercent),
          ringRadius: index === 0 && snapshot.limits.length > 1 ? 17 : 27,
        })),
        stale: snapshot.stale,
        title: 'Kimi Code',
      }}
      loading={loading}
    />
  );
}

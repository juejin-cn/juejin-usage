import { useCallback, useEffect, useRef, useState } from 'react';
import {
  zcodeRemainingPercent,
  type ZcodeSubscriptionSnapshot,
} from '../../shared/zcode-subscription';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';

const INITIAL_SNAPSHOT: ZcodeSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

/** ZCode's locally authorized Coding Plan allowance. */
export function ZcodeSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<ZcodeSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await window.tud.getZcodeSubscription());
    } catch {
      setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 ZCode 订阅信息' });
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
        icon: <SubscriptionBrandIcon brand="zcode" />,
        metrics: snapshot.limits
          .filter((limit) => limit.id !== 'mcp')
          .map((limit, index, all) => ({
            color: index === 0 && all.length > 1 ? '#7dcf00' : '#2b7eff',
            label: limit.label,
            remainingPercent: zcodeRemainingPercent(limit.usedPercent),
          })),
        stale: false,
        planLabel: snapshot.planLabel,
        title: 'ZCode',
      }}
      loading={loading}
    />
  );
}

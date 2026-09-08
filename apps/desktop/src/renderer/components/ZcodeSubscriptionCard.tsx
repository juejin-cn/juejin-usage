import { useCallback, useEffect, useRef, useState } from 'react';
import zaiIcon from '@lobehub/icons-static-svg/icons/zai.svg';
import {
  zcodeRemainingPercent,
  type ZcodeSubscriptionSnapshot,
} from '../../shared/zcode-subscription';
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
        iconSrc: zaiIcon,
        metrics: snapshot.limits
          .filter((limit) => limit.id !== 'mcp')
          .map((limit, index, all) => ({
            color: index === 0 && all.length > 1 ? '#7dcf00' : '#2b7eff',
            label: limit.label,
            remainingPercent: zcodeRemainingPercent(limit.usedPercent),
            ringRadius: index === 0 && all.length > 1 ? 17 : 27,
          })),
        stale: snapshot.stale,
        title: 'ZCode',
      }}
      loading={loading}
    />
  );
}

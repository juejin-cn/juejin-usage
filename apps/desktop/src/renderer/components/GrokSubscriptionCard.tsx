import { useCallback, useEffect, useRef, useState } from 'react';
import grokIcon from '@lobehub/icons-static-svg/icons/grok.svg';
import {
  grokRemainingPercent,
  type GrokSubscriptionSnapshot,
} from '../../shared/grok-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';

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

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await window.tud.getGrokSubscription());
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
        iconSrc: grokIcon,
        metrics: snapshot.limits.map((limit, index) => ({
          color: index === 0 && snapshot.limits.length > 1 ? '#7dcf00' : '#2b7eff',
          label: limit.label,
          remainingPercent: grokRemainingPercent(limit.usedPercent),
          ringRadius: index === 0 && snapshot.limits.length > 1 ? 17 : 27,
        })),
        stale: snapshot.stale,
        title: 'Grok',
      }}
      loading={loading}
    />
  );
}

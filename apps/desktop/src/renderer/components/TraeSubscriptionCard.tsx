import { useCallback, useEffect, useRef, useState } from 'react';
import {
  traeRemainingPercent,
  type TraeRegion,
  type TraeSubscriptionSnapshot,
} from '../../shared/trae-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: TraeSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  region: 'global',
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

interface TraeSubscriptionCardProps {
  region: TraeRegion;
  title: string;
  fetcher: () => Promise<TraeSubscriptionSnapshot>;
}

/** Compact TRAE IDE entitlement summary for the macOS tray. */
export function TraeSubscriptionCard({ region, title, fetcher }: TraeSubscriptionCardProps) {
  const [snapshot, setSnapshot] = useState<TraeSubscriptionSnapshot>({
    ...INITIAL_SNAPSHOT,
    region,
  });
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await fetcher());
    } catch {
      setSnapshot({ ...INITIAL_SNAPSHOT, region, message: '暂时无法读取 TRAE 订阅信息' });
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, [fetcher, region]);

  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  return (
    <SubscriptionUsageCard
      data={{
        icon: <SubscriptionBrandIcon brand="trae" />,
        metrics: snapshot.limits.map((limit, index) => ({
          color: ['#7dcf00', '#2b7eff', '#f59e0b'][index] ?? '#2b7eff',
          label: limit.label,
          remainingPercent: traeRemainingPercent(limit.usedPercent),
        })),
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title,
      }}
      loading={loading}
    />
  );
}

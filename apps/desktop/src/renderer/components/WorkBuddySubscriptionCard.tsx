import { useCallback, useEffect, useRef, useState } from 'react';
import {
  workBuddyRemainingPercent,
  type WorkBuddyRegion,
  type WorkBuddySubscriptionSnapshot,
} from '../../shared/workbuddy-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: WorkBuddySubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  region: 'global',
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

interface WorkBuddySubscriptionCardProps {
  region: WorkBuddyRegion;
  title: string;
  fetcher: () => Promise<WorkBuddySubscriptionSnapshot>;
}

/** Compact WorkBuddy account resource summary for the macOS tray. */
export function WorkBuddySubscriptionCard({ region, title, fetcher }: WorkBuddySubscriptionCardProps) {
  const [snapshot, setSnapshot] = useState<WorkBuddySubscriptionSnapshot>({
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
      setSnapshot({ ...INITIAL_SNAPSHOT, region, message: '暂时无法读取 WorkBuddy 订阅信息' });
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
        icon: <SubscriptionBrandIcon brand="codebuddy" />,
        metrics: snapshot.limits.slice(0, 2).map((limit, index) => ({
          color: index === 0 && snapshot.limits.length > 1 ? '#7dcf00' : '#2b7eff',
          label: workBuddyLabel(region, limit.label),
          remainingPercent: workBuddyRemainingPercent(limit.usedPercent),
        })),
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title,
      }}
      loading={loading}
    />
  );
}

function workBuddyLabel(region: WorkBuddyRegion, label: string): string {
  const normalized = label.toLowerCase();
  if (region === 'global') {
    if (normalized === 'credits' || normalized === '积分') return 'Credits';
    if (normalized === 'bonus' || normalized === '赠送') return 'Bonus';
    return label;
  }
  if (normalized === 'credits') return '积分';
  if (normalized === 'bonus') return '赠送';
  return label;
}

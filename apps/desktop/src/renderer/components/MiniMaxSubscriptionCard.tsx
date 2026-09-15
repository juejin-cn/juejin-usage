import { useCallback, useEffect, useRef, useState } from 'react';
import {
  miniMaxRemainingPercent,
  type MiniMaxSubscriptionSnapshot,
} from '../../shared/minimax-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: MiniMaxSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  region: null,
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Compact local MiniMax Code Coding Plan allowance summary for the macOS tray. */
export function MiniMaxSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<MiniMaxSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await window.tud.getMiniMaxSubscription());
    } catch {
      setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 MiniMax Code 订阅信息' });
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

  const title = snapshot.region === 'mainland'
    ? 'Minimax CN'
    : snapshot.region === 'global'
      ? 'Minimax'
      : 'Minimax';

  return (
    <SubscriptionUsageCard
      data={{
        icon: <SubscriptionBrandIcon brand="minimax" />,
        metrics: snapshot.limits.map((limit, index) => ({
          color: index === 0 && snapshot.limits.length > 1 ? '#ff6a00' : '#2b7eff',
          label: limit.label,
          remainingPercent: miniMaxRemainingPercent(limit.usedPercent),
        })),
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title,
      }}
      loading={loading}
    />
  );
}

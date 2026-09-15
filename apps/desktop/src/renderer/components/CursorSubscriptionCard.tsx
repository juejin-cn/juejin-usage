import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cursorRemainingPercent,
  type CursorSubscriptionSnapshot,
} from '../../shared/cursor-subscription';
import { SubscriptionUsageCard, type SubscriptionUsageMetric } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: CursorSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  cursorModels: null,
  otherModels: null,
  plan: null,
  fetchedAt: null,
  stale: false,
  message: null,
};

/** Cursor subscription pools from the locally signed-in desktop account. */
export function CursorSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<CursorSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      setSnapshot(await window.tud.getCursorSubscription());
    } catch {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        message: '暂时无法读取 Cursor 订阅信息',
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

  const metrics: SubscriptionUsageMetric[] = snapshot.plan
    ? [{
        color: '#2b7eff',
        label: 'Plan',
        remainingPercent: cursorRemainingPercent(snapshot.plan.usedPercent),
      }]
    : [
        {
          color: '#7dcf00',
          label: 'Cursor',
          remainingPercent: snapshot.cursorModels
            ? cursorRemainingPercent(snapshot.cursorModels.usedPercent)
            : null,
        },
        {
          color: '#2b7eff',
          label: 'Other',
          remainingPercent: snapshot.otherModels
            ? cursorRemainingPercent(snapshot.otherModels.usedPercent)
            : null,
        },
      ];

  return (
    <SubscriptionUsageCard
      data={{
        icon: <SubscriptionBrandIcon brand="cursor" />,
        metrics,
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title: 'Cursor',
      }}
      loading={loading}
    />
  );
}

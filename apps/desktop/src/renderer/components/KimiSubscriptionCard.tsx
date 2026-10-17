import { subscriptionApi } from '../lib/subscription-api';
import { subscriptionPoolKey } from '../lib/subscription-details';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import {
  kimiRemainingPercent,
  type KimiSubscriptionSnapshot,
} from '../../shared/kimi-subscription';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { selectKimiSubscription } from '../lib/kimi-subscription-state';

/** A single Kimi subscription card backed by independent local readers. */
export function KimiSubscriptionCard() {
  const [snapshots, setSnapshots] = useState<KimiSubscriptionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshots(await subscriptionApi.getKimiSubscription({ forceRefresh }));
    } catch {
      setSnapshots([]);
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

  const snapshot = selectKimiSubscription(snapshots);
  if (!snapshot) return null;
  const title = 'Kimi';
  const feedback = snapshot.message
    ?? (snapshot.limits.length === 0 ? '当前账号暂未提供可显示的额度。' : null);

  return (
    <SubscriptionUsageCard
      data={{
        icon: <SubscriptionBrandIcon brand="kimi" />,
        metrics: snapshot.limits.map((limit, index) => ({
          color: index === 0 && snapshot.limits.length > 1 ? '#7dcf00' : '#2b7eff',
          poolKey: subscriptionPoolKey(snapshot.source === 'desktop' ? 'Kimi Desktop' : 'Kimi Code', limit),
          label: limit.label,
          remainingPercent: kimiRemainingPercent(limit.usedPercent),
          resetsAt: limit.resetsAt,
        })),
        planLabel: snapshot.planLabel,
        showFreePlan: true,
        stale: snapshot.stale,
        title,
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
      feedback={feedback ? (
        <div className="grid gap-2 text-xs leading-relaxed">
          <p className="break-words text-muted" role="status">{feedback}</p>
          <Button
            aria-label={`重试读取 ${title} 订阅额度`}
            className="justify-self-start"
            isDisabled={loading}
            isPending={loading}
            onPress={() => void reload(true)}
            size="sm"
            variant="outline"
          >
            {loading ? '重试中…' : '重试'}
          </Button>
        </div>
      ) : null}
    />
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GrokBotSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription';
import { subscriptionApi } from '../lib/subscription-api';
import { subscriptionDetails, subscriptionPoolKey } from '../lib/subscription-details';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const EMPTY: GrokBotSubscriptionSnapshot = {
  status: 'not-installed', planLabel: null, weekly: null, fetchedAt: null, stale: false, message: null,
};

export function GrokBotSubscriptionCard() {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const reload = useCallback(async (forceRefresh = false) => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    try { setSnapshot(await subscriptionApi.getGrokBotSubscription({ forceRefresh })); }
    catch { setSnapshot({ ...EMPTY, status: 'unavailable', message: '暂时无法读取 Grok Bot 额度，请刷新重试' }); }
    finally { pending.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const focus = () => void reload();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [reload]);
  const weekly = snapshot.weekly;
  return <SubscriptionUsageCard
    data={{
      title: 'Grok Bot', icon: <SubscriptionBrandIcon brand="grok" />,
      planLabel: snapshot.planLabel, stale: snapshot.stale,
      // Keep installed-but-unavailable accounts visible, including the manual unlock action.
      hasAccount: snapshot.status !== 'not-installed', message: snapshot.message,
      details: subscriptionDetails(snapshot, 'Grok Bot', '重置时间'),
      metrics: weekly ? [{
        label: weekly.expiresAt ? '试用' : '每周', color: '#2b7eff',
        poolKey: subscriptionPoolKey('Grok Bot', { label: '7d' }),
        remainingPercent: Math.max(0, Math.min(100, 100 - weekly.usedPercent)),
        resetsAt: weekly.expiresAt ?? weekly.resetsAt,
        resetDisplay: weekly.expiresAt ? 'days-only' : 'date-time',
      }] : [],
    }}
    loading={loading} onRefresh={() => void reload(true)}
  />;
}

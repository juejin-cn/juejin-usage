import { useCallback, useEffect, useRef, useState } from 'react';
import type { TraeGlobalSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription';
import { subscriptionApi } from '@/lib/subscription-api';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const initial: TraeGlobalSubscriptionSnapshot = { status: 'not-installed', planLabel: null, limits: [], fetchedAt: null, stale: false, message: null };

export function TraeGlobalSubscriptionCard() {
  const [snapshot, setSnapshot] = useState(initial), [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const reload = useCallback(async (forceRefresh = false) => {
    if (pending.current) return;
    pending.current = true; setLoading(true);
    try { setSnapshot(await subscriptionApi.getTraeGlobalSubscription({ forceRefresh })); }
    catch { setSnapshot({ ...initial, status: 'temporarily-unavailable', message: '暂时无法读取 Trae 国际版额度。' }); }
    finally { pending.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  return <SubscriptionUsageCard loading={loading} onRefresh={() => void reload(true)} data={{
    title: 'Trae 国际版', icon: <SubscriptionBrandIcon brand="trae" />, planLabel: snapshot.planLabel, showFreePlan: true,
    stale: snapshot.stale, message: snapshot.message,
    hasAccount: !['not-installed', 'not-signed-in'].includes(snapshot.status),
    metrics: snapshot.limits.map(limit => ({ poolKey: `trae-${limit.id}`, label: limit.label, color: '#2b7eff', remainingPercent: 100 - limit.usedPercent, resetsAt: limit.resetsAt,
      valueText: `$${Math.max(0, limit.amounts.total - limit.amounts.used).toFixed(2)} / $${limit.amounts.total.toFixed(2)}` })),
    detailRows: snapshot.status === 'ready' ? [{ label: '数据范围', value: '账号下所有设备；本地展示，不上传排行榜' }] : undefined,
  }} />;
}

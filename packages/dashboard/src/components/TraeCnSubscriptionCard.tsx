import { useCallback, useEffect, useRef, useState } from 'react';
import type { TraeCnSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription';
import { subscriptionApi } from '@/lib/subscription-api';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const initial: TraeCnSubscriptionSnapshot = { status: 'not-installed', planLabel: null, limits: [], fetchedAt: null, stale: false, message: null };

export function TraeCnSubscriptionCard() {
  const [snapshot, setSnapshot] = useState(initial), [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const reload = useCallback(async (forceRefresh = false) => {
    if (pending.current) return;
    pending.current = true; setLoading(true);
    try { setSnapshot(await subscriptionApi.getTraeCnSubscription({ forceRefresh })); }
    catch { setSnapshot({ ...initial, status: 'temporarily-unavailable', message: '暂时无法读取 Trae 国内版额度。' }); }
    finally { pending.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  return <SubscriptionUsageCard loading={loading} onRefresh={() => void reload(true)} data={{
    title: 'Trae 国内版', icon: <SubscriptionBrandIcon brand="trae" />, planLabel: snapshot.planLabel, showFreePlan: true,
    stale: snapshot.stale, message: snapshot.message,
    hasAccount: !['not-installed', 'not-signed-in'].includes(snapshot.status),
    metrics: snapshot.limits.map(limit => ({ poolKey: `trae-cn-${limit.id}`, label: limit.label, color: '#2b7eff', remainingPercent: 100 - limit.usedPercent, resetsAt: limit.resetsAt,
      hideProgress: limit.unlimited || limit.amounts.total === 0,
      valueText: limit.unlimited ? '不限量' : `${Math.max(0, (limit.amounts.total ?? 0) - limit.amounts.used).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} / ${(limit.amounts.total ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 积分` })),
    detailRows: snapshot.status === 'ready' ? [
      ...snapshot.limits.map((limit, index) => ({ label: `${limit.label}${snapshot.limits.length > 1 ? ` ${index + 1}` : ''} · 已用`,
        value: `${limit.amounts.used.toLocaleString('zh-CN', { maximumFractionDigits: 4 })} 积分` })),
      { label: '数据范围', value: '账号下所有设备；本地展示，不上传排行榜' },
    ] : undefined,
  }} />;
}

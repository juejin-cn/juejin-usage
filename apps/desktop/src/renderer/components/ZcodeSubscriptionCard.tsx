import { subscriptionApi } from '../lib/subscription-api';
import { subscriptionAbsoluteTime, subscriptionDetails, subscriptionPoolKey } from '../lib/subscription-details';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  zcodeRemainingPercent,
  type ZcodeSubscriptionSnapshot,
} from '../../shared/zcode-subscription';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';

const INITIAL_SNAPSHOT: ZcodeSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  provider: null,
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

  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await subscriptionApi.getZcodeSubscription({ forceRefresh }));
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
        detailRows: snapshot.resetCredits ? [
          ...(['fiveHour', 'weekly'] as const).flatMap((period) => {
            const label = period === 'fiveHour' ? '会话重置卡' : '每周重置卡';
            const cards = snapshot.resetCredits![period].filter((card) => card.expiresAt > Date.now() / 1000);
            const earliest = cards.length ? Math.min(...cards.map((card) => card.expiresAt)) : null;
            return [
              { label, value: `${cards.length} 张` },
              ...(earliest ? [{ label: `${label}最近到期`, value: subscriptionAbsoluteTime(earliest)! }] : []),
            ];
          }),
        ] : undefined,
        details: subscriptionDetails(snapshot, 'ZCode Coding Plan', '重置时间'),
        icon: <SubscriptionBrandIcon brand="zcode" />,
        metrics: snapshot.limits
          .filter((limit) => limit.id !== 'mcp')
          .map((limit, index, all) => ({
            color: index === 0 && all.length > 1 ? '#7dcf00' : '#2b7eff',
            poolKey: subscriptionPoolKey('ZCode Coding Plan', limit),
            label: limit.label,
            remainingPercent: zcodeRemainingPercent(limit.usedPercent),
            resetsAt: limit.resetsAt,
          })),
        stale: false,
        planLabel: snapshot.planLabel,
        title: snapshot.provider === 'bigmodel'
          ? 'ZCode CN'
          : snapshot.provider === 'zai'
            ? 'ZCode Global'
            : 'ZCode',
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
    />
  );
}

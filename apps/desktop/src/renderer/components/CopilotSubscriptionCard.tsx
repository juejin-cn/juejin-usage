import { subscriptionApi } from '../lib/subscription-api';
import { subscriptionDetails, subscriptionPoolKey } from '../lib/subscription-details';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CopilotSubscriptionSnapshot } from '../../shared/copilot-subscription';
import { SubscriptionUsageCard, type SubscriptionUsageMetric } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: CopilotSubscriptionSnapshot = {
  status: 'temporarily-unavailable',
  planLabel: null,
  limits: [],
  fetchedAt: null,
  stale: false,
  message: null,
};

/** GitHub Copilot allowances from the locally signed-in account. */
export function CopilotSubscriptionCard() {
  const [snapshot, setSnapshot] = useState<CopilotSubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const reload = useCallback(async (forceRefresh = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      setSnapshot(await subscriptionApi.getCopilotSubscription({ forceRefresh }));
    } catch {
      setSnapshot({
        ...INITIAL_SNAPSHOT,
        message: '暂时无法读取 Copilot 订阅信息',
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

  const metrics: SubscriptionUsageMetric[] = snapshot.limits.map((limit) => ({
    color: limit.id === 'completions' ? '#7dcf00' : '#2b7eff',
    poolKey: subscriptionPoolKey('GitHub Copilot', limit),
    label: limit.label,
    remainingPercent: limit.exhausted ? 0 : limit.unlimited ? 100 : limit.remainingPercent,
    resetsAt: limit.resetsAt,
    valueText: limit.exhausted ? '已用尽' : limit.unlimited ? '无限' : undefined,
  }));

  return (
    <SubscriptionUsageCard
      data={{
        details: subscriptionDetails(snapshot, 'GitHub Copilot', '重置时间'),
        icon: <SubscriptionBrandIcon brand="copilot" />,
        metrics,
        planLabel: snapshot.planLabel,
        stale: snapshot.stale,
        title: 'GitHub Copilot',
      }}
      loading={loading}
      onRefresh={() => void reload(true)}
    />
  );
}

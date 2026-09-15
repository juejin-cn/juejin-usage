import { useCallback, useEffect, useRef, useState } from 'react';
import { antigravityRemainingPercent, type AntigravitySubscriptionSnapshot } from '../../shared/antigravity-subscription';
import { SubscriptionUsageCard } from './SubscriptionUsageCard';
import { SubscriptionBrandIcon } from './SubscriptionBrandIcon';

const INITIAL_SNAPSHOT: AntigravitySubscriptionSnapshot = {
  status: 'temporarily-unavailable', planLabel: null, limits: [], fetchedAt: null, stale: false, message: null,
};

/** Antigravity's official account model quota. */
export function AntigravitySubscriptionCard() {
  const [snapshot, setSnapshot] = useState<AntigravitySubscriptionSnapshot>(INITIAL_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);
  const reload = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try { setSnapshot(await window.tud.getAntigravitySubscription()); }
    catch { setSnapshot({ ...INITIAL_SNAPSHOT, message: '暂时无法读取 Antigravity 订阅信息' }); }
    finally { requestInFlight.current = false; setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);
  return <SubscriptionUsageCard data={{
    icon: <SubscriptionBrandIcon brand="antigravity" />,
    metrics: snapshot.limits.map((limit, index) => ({
      color: index === 0 && snapshot.limits.length > 1 ? '#7dcf00' : '#2b7eff',
      label: geminiModelLabel(limit.label),
      remainingPercent: antigravityRemainingPercent(limit.usedPercent),
    })),
    planLabel: snapshot.planLabel,
    stale: snapshot.stale,
    title: 'Gemini',
  }} loading={loading} />;
}

function geminiModelLabel(label: string): string {
  return label.replace(/^gemini\s+/i, '') || label;
}

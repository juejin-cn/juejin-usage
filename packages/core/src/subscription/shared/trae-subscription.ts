export interface TraeGlobalSubscriptionSnapshot {
  status: 'ready' | 'not-installed' | 'not-signed-in' | 'expired' | 'temporarily-unavailable';
  planLabel: string | null;
  limits: Array<{ id: string; label: string; usedPercent: number; resetsAt: number | null; amounts: { used: number; total: number; unit: 'USD' } }>;
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const PLANS: Record<number, string> = { 0: 'Free', 1: 'Pro', 4: 'Pro+', 6: 'Ultra', 8: 'Lite' };

/** Actual website entitlement packs; a quota kind never determines the plan. */
export function mapTraeGlobalEntitlements(value: unknown, now = Date.now()): Pick<TraeGlobalSubscriptionSnapshot, 'limits' | 'planLabel'> {
  const root = object(value), limits: TraeGlobalSubscriptionSnapshot['limits'] = [];
  if (!Array.isArray(root.user_entitlement_pack_list)) throw new Error('TRAE_QUOTA_FORMAT_CHANGED');
  const plans = new Set<number>();
  for (const [index, raw] of root.user_entitlement_pack_list.entries()) {
    const pack = object(raw), base = object(pack.entitlement_base_info), usage = object(pack.usage);
    if (pack.is_hide === true || (typeof base.end_time === 'number' && base.end_time * 1000 < now)) continue;
    const type = base.product_type;
    if (typeof type === 'number' && PLANS[type]) plans.add(type);
    const extra = object(base.product_extra);
    const quota = object(object(extra.subscription_extra ?? extra.package_extra).quota);
    const isPackage = type === 2 || type === 5;
    for (const kind of ['basic', 'bonus'] as const) {
      const used = usage[`${kind}_usage_amount`], total = quota[`${kind}_usage_limit`];
      if (!amount(used) || !amount(total) || total <= 0) continue;
      const resetsAt = typeof base.end_time === 'number' && Number.isSafeInteger(base.end_time) && base.end_time > 0 ? base.end_time : null;
      limits.push({ id: `${index}-${kind}`, label: isPackage ? '额外额度' : kind === 'basic' ? '基础额度' : '奖励额度',
        usedPercent: Math.min(100, used / total * 100), resetsAt, amounts: { used, total, unit: 'USD' } });
    }
  }
  return { planLabel: [6, 4, 1, 8, 0].filter(type => plans.has(type)).map(type => PLANS[type])[0] ?? null, limits };
}

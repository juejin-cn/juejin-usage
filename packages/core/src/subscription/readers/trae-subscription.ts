import { hasTraeGlobalStorage, readTraeAccount, traeAccountRequest } from '../../parsers/trae-account.js';
import { mapTraeGlobalEntitlements, type TraeGlobalSubscriptionSnapshot } from '../shared/trae-subscription.js';
import { fetchSubscription } from '../transport.js';
import { createSubscriptionCache } from './subscription-cache.js';

const cache = createSubscriptionCache<TraeGlobalSubscriptionSnapshot>();
function unavailable(status: TraeGlobalSubscriptionSnapshot['status'], message: string): TraeGlobalSubscriptionSnapshot {
  return { status, planLabel: null, limits: [], fetchedAt: null, stale: false, message };
}
export async function readTraeGlobalSubscription(options: { forceRefresh?: boolean } = {}): Promise<TraeGlobalSubscriptionSnapshot> {
  let account;
  try { account = await readTraeAccount(); }
  catch { return cache('unreadable', async () => unavailable('not-signed-in', '无法读取 Trae 国际版登录态，请更新并重新登录 Trae。'), true); }
  if (!account) return cache('signed-out', async () => unavailable(hasTraeGlobalStorage() ? 'not-signed-in' : 'not-installed', '请先安装并登录 Trae 国际版。'), true);
  return cache(account.identity, async () => {
    try {
      const data = await traeAccountRequest(account, 'user_current_entitlement_list', { require_usage: true, full_data: true }, fetchSubscription);
      if ((await readTraeAccount())?.identity !== account.identity) return unavailable('not-signed-in', 'Trae 账号已切换，请刷新。');
      const mapped = mapTraeGlobalEntitlements(data);
      if (!mapped.limits.length) return unavailable('temporarily-unavailable', 'Trae 暂未返回可用的金额额度；旧计次套餐尚不支持。');
      return { status: 'ready', ...mapped, fetchedAt: Math.floor(Date.now() / 1000), stale: false, message: null };
    } catch (error) {
      return error instanceof Error && error.message === 'TRAE_AUTH_EXPIRED'
        ? unavailable('expired', 'Trae 登录已过期，请在 Trae 中重新登录。')
        : unavailable('temporarily-unavailable', '暂时无法读取 Trae 额度，请稍后重试。');
    }
  }, options.forceRefresh);
}

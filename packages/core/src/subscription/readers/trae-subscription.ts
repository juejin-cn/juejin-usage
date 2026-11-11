import { hasTraeStorage, readTraeAccount, traeAccountRequest, type TraeAccountRegion } from '../../parsers/trae-account.js';
import { mapTraeGlobalEntitlements, mapTraeCnEntitlements, type TraeGlobalSubscriptionSnapshot, type TraeCnSubscriptionSnapshot, type TraeLocalSubscriptionSnapshot } from '../shared/trae-subscription.js';
import { fetchSubscription } from '../transport.js';
import { createSubscriptionCache } from './subscription-cache.js';

function unavailable(status: TraeLocalSubscriptionSnapshot['status'], message: string): TraeLocalSubscriptionSnapshot {
  return { status, planLabel: null, limits: [], fetchedAt: null, stale: false, message };
}
export function createTraeSubscriptionReader(region: TraeAccountRegion, fetcher: typeof fetch = fetchSubscription) {
  const cache = createSubscriptionCache<TraeLocalSubscriptionSnapshot>();
  const title = region === 'mainland' ? 'Trae 国内版' : 'Trae 国际版';
  return async (options: { forceRefresh?: boolean } = {}): Promise<TraeLocalSubscriptionSnapshot> => {
    let account;
    try { account = await readTraeAccount(region); }
    catch { return cache('unreadable', async () => unavailable('not-signed-in', `无法读取 ${title} 登录态，请更新并重新登录客户端。`), true); }
    if (!account) return cache('signed-out', async () => unavailable(hasTraeStorage(region) ? 'not-signed-in' : 'not-installed', `请先安装并登录 ${title}。`), true);
    return cache(account.identity, async () => {
      try {
        const mainland = region === 'mainland';
        const data = await traeAccountRequest(account, mainland ? 'ide_user_ent_usage' : 'user_current_entitlement_list',
          mainland ? { require_usage: true, req_source: 0 } : { require_usage: true, full_data: true }, fetcher);
        if ((await readTraeAccount(region))?.identity !== account.identity) return unavailable('not-signed-in', `${title} 账号已切换，请刷新。`);
        const mapped = mainland ? mapTraeCnEntitlements(data) : mapTraeGlobalEntitlements(data);
        if (!mapped.limits.length) return unavailable('temporarily-unavailable', `${title} 暂未返回可用${mainland ? '积分' : '金额'}额度。`);
        return { status: 'ready', ...mapped, fetchedAt: Math.floor(Date.now() / 1000), stale: false, message: null };
      } catch (error) {
        // A failed request must not restore the previous account's cached quota after sign-out.
        try {
          if ((await readTraeAccount(region))?.identity !== account.identity) return unavailable('not-signed-in', `${title} 账号已变化，请刷新。`);
        } catch { return unavailable('not-signed-in', `无法读取 ${title} 登录态，请重新登录客户端。`); }
        return error instanceof Error && error.message === 'TRAE_AUTH_EXPIRED'
          ? unavailable('expired', `${title} 登录已过期，请在客户端重新登录。`)
          : unavailable('temporarily-unavailable', `暂时无法读取 ${title} 额度，请稍后重试。`);
      }
    }, options.forceRefresh);
  };
}
const readGlobal = createTraeSubscriptionReader('global');
const readMainland = createTraeSubscriptionReader('mainland');
export const readTraeGlobalSubscription = (options?: { forceRefresh?: boolean }) => readGlobal(options) as Promise<TraeGlobalSubscriptionSnapshot>;
export const readTraeCnSubscription = (options?: { forceRefresh?: boolean }) => readMainland(options) as Promise<TraeCnSubscriptionSnapshot>;

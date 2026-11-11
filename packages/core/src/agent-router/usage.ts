import { CHANNEL_CATALOG } from './channel-catalog.js';
import type { SubscriptionAuth, SubscriptionChannel } from './subscription-types.js';

export interface ProviderUsage {
  state: 'available' | 'unknown' | 'expired'; checkedAt: string; plan?: string; accountName?: string;
  accountId?: string; email?: string; accountError?: boolean; quotaError?: boolean; quotaAuthRequired?: boolean;
  windows: Array<{ percent?: number; used?: number; limit?: number; remaining?: number; unit: string; resetsAt?: string }>;
}
/** Expose quota data and recognized plan names, never raw vendor errors or credentials. */
export function sanitizeUsage(value: unknown): ProviderUsage {
  const result: ProviderUsage = { state: 'unknown', checkedAt: new Date().toISOString(), windows: [] };
  if (!value || typeof value !== 'object') return result;
  const raw = value as Record<string, unknown>;
  if (raw.signIn === 'expired') { result.state = 'expired'; return result; }
  if (raw.error) return result;
  if (typeof raw.plan === 'string' && /^(free(?: plan)?|pro(?:\+| plus)?|premium|plus|team|business|enterprise|individual|student|ultimate|max|trial)$/i.test(raw.plan.trim())) {
    result.plan = raw.plan.trim();
  }
  const balance = typeof raw.balance === 'string' && raw.balance.length <= 512 ? /^(\d+(?:\.\d+)?) credits(?: \([^\r\n]*\))?$/.exec(raw.balance) : null;
  if (balance && Number.isFinite(Number(balance[1]))) result.windows.push({ remaining: Number(balance[1]), unit: 'credits' });
  for (const item of (Array.isArray(raw.windows) ? raw.windows : []).slice(0, 8 - result.windows.length)) {
    if (!item || typeof item !== 'object') continue;
    const window = item as Record<string, unknown>;
    const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    const used = number(window.amount); const limit = number(window.limit); const remaining = number(window.balance);
    const percentage = number(window.used); const percent = percentage !== undefined && percentage <= 100 ? percentage : undefined;
    if (used === undefined && limit === undefined && remaining === undefined && percent === undefined) continue;
    const reset = typeof window.resetsAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(window.resetsAt) ? Date.parse(window.resetsAt) : NaN;
    result.windows.push({ ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}), ...(percent !== undefined && percent <= 100 ? { percent } : {}), ...(used !== undefined ? { used } : {}), ...(limit !== undefined ? { limit } : {}), ...(remaining !== undefined ? { remaining } : {}), unit: ['credits', 'tokens', 'requests', 'USD', 'CNY'].includes(String(window.unit)) ? String(window.unit) : 'units' });
  }
  if (result.windows.length) result.state = 'available';
  return result;
}

/** Only expose a verified display label, never an access token. */
export function usageAccountName(provider: string, auth: Record<string, unknown>): string | undefined {
  if (!CHANNEL_CATALOG.some(channel => channel.id === provider) || auth.type !== 'oauth') return undefined;
  const value = auth.accountName;
  return typeof value === 'string' && value.trim() && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value)
    && ![auth.access, auth.refresh, auth.key].includes(value) ? value.trim() : undefined;
}

/** Whitelist display fields separately from quota data; credentials never cross IPC. */
export function accountDetails(provider: string, auth: SubscriptionAuth, profile: Record<string, unknown> = {}): Partial<ProviderUsage> {
  if (!CHANNEL_CATALOG.some(channel => channel.id === provider)) return {};
  const clean = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value)
    && ![auth.access, auth.refresh, auth.key].includes(value) && !/^(?:Bearer |sk-|eyJ)/.test(value) ? value.trim() : undefined;
  const accountName = clean(profile.accountName) || clean(auth.accountName) || clean(auth.name);
  const accountId = clean(profile.accountId) || clean(auth.accountId) || (!auth.source ? clean(auth.uid) : undefined);
  const email = clean(profile.email) || clean(auth.email) || (accountName?.includes('@') ? accountName : undefined);
  const plan = sanitizeUsage({ plan: profile.plan || auth.plan }).plan;
  return { ...(accountName ? { accountName } : {}), ...(accountId ? { accountId } : {}), ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {}), ...(plan ? { plan } : {}) };
}

export async function readSubscriptionDetails(provider: string, channel: SubscriptionChannel, getAuth: () => Promise<SubscriptionAuth>, saved: SubscriptionAuth = {}): Promise<ProviderUsage> {
  let auth: SubscriptionAuth;
  try { auth = await getAuth(); }
  catch (error) { return { ...sanitizeUsage((error as Error)?.message === 'SUBSCRIPTION_LOGIN_REQUIRED' ? { signIn: 'expired' } : null), ...accountDetails(provider, saved), accountError: true }; }
  const [profile, quota] = await Promise.allSettled([channel.auth.account?.(async () => auth), channel.auth.usage?.(async () => auth)]);
  const result = sanitizeUsage(quota.status === 'fulfilled' ? quota.value : null);
  const details = accountDetails(provider, auth, profile.status === 'fulfilled' ? profile.value : undefined);
  return { ...details, ...result, ...(details.accountName ? { accountName: details.accountName } : {}), ...(profile.status === 'rejected' ? { accountError: true } : {}), ...(quota.status === 'rejected' ? { quotaError: true, ...((quota.reason as Error)?.message === 'SUBSCRIPTION_QUOTA_AUTH_REQUIRED' ? { quotaAuthRequired: true } : {}) } : {}) };
}

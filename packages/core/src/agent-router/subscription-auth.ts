import type { LoginMethod, SubscriptionAuth, SubscriptionChannel } from './subscription-types.js';

/** Subscription credentials may be an API key, an OAuth refresh token, or a local-login reference. */
export function validSubscriptionAuth(value: unknown): value is SubscriptionAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const auth = value as SubscriptionAuth;
  if (JSON.stringify(auth).length > 65536) return false;
  const token = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 32768 && !/[\r\n\x00]/.test(v);
  if (auth.type === 'api') return token(auth.key);
  return auth.type === 'oauth' && (token(auth.access) || token(auth.refresh) || token(auth.source));
}
export function normalizeSubscriptionAuth(value: SubscriptionAuth): SubscriptionAuth {
  if (!['success', 'oauth', 'api'].includes(String(value.type))) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
  const { type: _type, ...fields } = value;
  const kind = value.type === 'api' ? 'api' : value.type === 'oauth' || typeof fields.access === 'string' || typeof fields.refresh === 'string' ? 'oauth' : typeof fields.key === 'string' ? 'api' : 'oauth';
  const result: SubscriptionAuth = { ...fields, type: kind };
  if (!validSubscriptionAuth(result)) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
  return result;
}
export function validLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
/** Functions stay in the worker; only the prompts relevant to current answers cross IPC. */
export function subscriptionLoginMethods(channel: SubscriptionChannel, inputs: Record<string, string> = {}): LoginMethod[] {
  return channel.auth.methods.map((method, index) => ({ index, type: method.type === 'api' ? 'api' : 'oauth', label: method.label || `登录方式 ${index + 1}`,
    prompts: (method.prompts ?? []).filter(p => !p.condition || p.condition(inputs)).map(({ key, type, message, placeholder, options }) => ({ key, type, message, ...(placeholder ? { placeholder } : {}), ...(options ? { options } : {}) })),
  }));
}

/** One refresh per account, shared by inference, catalog and usage reads. */
export function subscriptionAuthReader(get: () => SubscriptionAuth | null, save: (auth: SubscriptionAuth) => Promise<void>, channel: () => Promise<SubscriptionChannel>, now = Date.now): () => Promise<SubscriptionAuth> {
  let refreshing: Promise<void> | null = null;
  // A rotated token must survive a transient vault failure. Never spend the
  // previous refresh token twice while retrying persistence.
  let pending: { previous: SubscriptionAuth; next: SubscriptionAuth } | null = null;
  return async () => {
    if (!get()) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
    const adapter = await channel();
    const current = get();
    if (!current) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
    const expires = Number(current.expires);
    if (pending && pending.previous !== current) pending = null;
    if (pending || (current.type === 'oauth' && Number.isFinite(expires) && expires > 0 && expires <= now() + (adapter.auth.refreshLead ?? 60000) && adapter.auth.refresh)) {
      if (!refreshing) {
        refreshing = (async () => {
          try {
            if (!pending) {
              const next = await adapter.auth.refresh!(current);
              if (next) pending = { previous: current, next: { ...current, ...next, type: 'oauth' } };
            }
            if (pending) { await save(pending.next); pending = null; }
          } catch (error) {
            throw new Error((error as { signIn?: string })?.signIn === 'expired' ? 'SUBSCRIPTION_LOGIN_REQUIRED' : 'SUBSCRIPTION_REFRESH_FAILED');
          }
        })().finally(() => { refreshing = null; });
      }
      await refreshing;
    }
    return get()!;
  };
}

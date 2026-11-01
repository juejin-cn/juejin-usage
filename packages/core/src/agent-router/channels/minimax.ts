import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, json, modelRows, oauth, readJson, record, quotaResponse, token } from './http.js';
export function minimaxChannel(global: boolean, fetcher: typeof fetch = fetch): SubscriptionChannel {
  const account = `https://account.minimax.${global ? 'io' : 'cn'}`;
  const root = `https://agent.minimax.${global ? 'io' : 'cn'}`;
  const form = async (path: string, fields: Record<string, string>) => {
    const r = await fetcher(account + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'mcode-public', ...fields }) });
    const d = record(await readJson(r));
    if (d.error === 'invalid_grant') throw new ChannelError(401);
    if (!r.ok && !['authorization_pending', 'slow_down'].includes(d.error)) throw new ChannelError(r.status);
    return d;
  };
  return {
    models: async auth => {
      const d = await json(fetcher, root + '/mavis/api/v1/models?region=' + (global ? 'en' : 'cn') + '&buildEnv=prod', { headers: { authorization: `Bearer ${token(auth.access)}` } });
      const models = d.providers?.find((p: any) => p.providerId === 'minimax')?.config?.models;
      return modelRows(Object.entries(record(models)).map(([id, m]) => ({ ...record(m), id })));
    },
    auth: {
      refreshLead: 120000,
      refresh: async auth => oauth(await form('/oauth2/token', { grant_type: 'refresh_token', refresh_token: token(auth.refresh), scope: 'agent.default', audience: 'agent-backend' }), auth),
      methods: [{ type: 'oauth', label: 'MiniMax Code 设备授权', authorize: async () => {
        const verifier = randomBytes(32).toString('base64url');
        const d = await form('/oauth2/device/code', { scope: 'agent.default', audience: 'agent-backend', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        const userCode = token(d.user_code); const byUser = !d.device_code;
        const deadline = d.expired_in > 1e12 ? d.expired_in : Date.now() + Math.min(900, Number(d.expires_in || d.expired_in || 600)) * 1000;
        return { url: token(d.verification_uri_complete || d.verification_uri || d.verification_url), instructions: `输入验证码：${userCode}`, method: 'auto', callback: async () => {
          let interval = Math.max(1000, byUser ? Number(d.interval || 5000) : Number(d.interval || 5) * 1000);
          while (Date.now() < deadline) {
            await delay(Math.min(interval, deadline - Date.now()));
            if (Date.now() >= deadline) break;
            const result = await form('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', code_verifier: verifier, [byUser ? 'user_code' : 'device_code']: byUser ? userCode : token(d.device_code) });
            if (result.access_token) return oauth(result);
            if (['slow_down'].includes(result.error || result.status)) { interval += 5000; continue; }
            if (['authorization_pending', 'pending'].includes(result.error || result.status)) continue;
            throw new Error('SUBSCRIPTION_LOGIN_FAILED');
          }
          throw new Error('SUBSCRIPTION_LOGIN_TIMEOUT');
        } };
      } }],
      transport: async getAuth => ({ baseURL: root + '/mavis/api/v1/llm/v1', fetch: async (url, init) => {
        const auth = await getAuth();
        return quotaResponse(await fetcher(url, { ...init, redirect: 'error', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${token(auth.access)}`, 'x-api-key': 'sk-xxx', 'user-agent': 'MiniMaxAgent', 'x-mavis-agent-id': 'main', 'x-mavis-timezone-offset': String(-new Date().getTimezoneOffset() * 60), 'x-mavis-session-id': new Headers(init?.headers).get('x-jusage-session') || randomUUID() } }));
      } }),
    },
  };
}

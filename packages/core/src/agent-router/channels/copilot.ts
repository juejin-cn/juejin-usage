import { beginGithubDeviceGrant } from '../native/github-device.js';
import type { SubscriptionChannel, SubscriptionAuth } from '../subscription-types.js';
import { bearer, httpsOrigin, json, modelRows, token } from './http.js';
const clientHeaders = { 'user-agent': 'GitHubCopilotChat/0.68.0', 'editor-version': 'vscode/1.140.0', 'editor-plugin-version': 'copilot-chat/0.68.0', 'copilot-integration-id': 'vscode-chat' };
export function copilotChannel(fetcher: typeof fetch = fetch): SubscriptionChannel {
  const hosts = (auth: SubscriptionAuth) => {
    const origin = httpsOrigin(String(auth.origin || 'https://github.com'));
    const host = new URL(origin).hostname;
    return { origin, api: `https://api.${host}`, inference: host === 'github.com' ? 'https://api.githubcopilot.com' : `https://copilot-api.${host}` };
  };
  const refresh = async (auth: SubscriptionAuth): Promise<SubscriptionAuth> => {
    const data = await json(fetcher, hosts(auth).api + '/copilot_internal/v2/token', { headers: { ...clientHeaders, authorization: `Bearer ${token(auth.refresh)}` } });
    return { ...auth, type: 'oauth', access: token(data.token), expires: Number(data.expires_at) * 1000 };
  };
  return {
    models: async auth => modelRows((await json(fetcher, hosts(auth).inference + '/models', { headers: { ...clientHeaders, ...bearer(auth) } })).data),
    auth: {
      account: async getAuth => {
        const auth = await getAuth();
        const user = await json(fetcher, hosts(auth).api + '/user', { headers: { ...clientHeaders, authorization: `Bearer ${token(auth.refresh)}` } });
        return { accountName: user.name || user.login, accountId: user.login, email: user.email };
      },
      refresh, refreshLead: 300000,
      methods: [{ type: 'oauth', label: 'GitHub 设备授权', prompts: [
        { key: 'deployment', type: 'select', message: 'GitHub 账号类型', options: [{ value: 'public', label: 'GitHub.com' }, { value: 'enterprise', label: 'GitHub Enterprise' }] },
        { key: 'origin', type: 'text', message: '企业 GitHub 域名', condition: a => a.deployment === 'enterprise' },
      ], authorize: async (input = {}) => {
        const origin = input.deployment === 'enterprise' ? httpsOrigin(input.origin) : 'https://github.com';
        const flow = await beginGithubDeviceGrant({ origin, clientId: 'Iv1.b507a08c87ecfe98', scope: 'read:user', fetcher });
        return { url: flow.url, instructions: flow.instructions, method: 'auto', callback: async () => refresh({ type: 'oauth', origin, refresh: await flow.token() }) };
      } }],
      usage: async getAuth => {
        const auth = await getAuth(); const d = await json(fetcher, hosts(auth).api + '/copilot_internal/user', { headers: { ...clientHeaders, authorization: `Bearer ${token(auth.refresh)}` } });
        return { plan: d.copilot_plan, windows: Object.values(d.quota_snapshots || {}).filter((v: any) => !v.unlimited && Number.isFinite(v.percent_remaining)).map((v: any) => ({ used: 100 - v.percent_remaining, resetsAt: d.quota_reset_date })) };
      },
      transport: async getAuth => ({ fetch: async (url, init) => {
        const auth = await getAuth(); const target = new URL(String(url)); const body = JSON.parse(String(init?.body || '{}'));
        const last = body.messages?.at(-1); const vision = body.messages?.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'));
        return fetcher(hosts(auth).inference + target.pathname, { ...init, redirect: 'error', headers: {
          'content-type': 'application/json', ...clientHeaders, ...bearer(auth), 'openai-intent': 'conversation-edits',
          'x-initiator': ['tool', 'assistant'].includes(last?.role) ? 'agent' : 'user', ...(vision ? { 'copilot-vision-request': 'true' } : {}),
        } });
      } }),
    },
  };
}

import { randomBytes, randomUUID } from 'node:crypto';
import type { SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, type Json, json, modelRows, poll, post, token } from './http.js';

export function zcodeChannel(fetcher: typeof fetch = fetch): SubscriptionChannel {
  const call = async (url: string, init: RequestInit = {}): Promise<any> => {
    const d = await json(fetcher, url, init);
    if (d.code !== undefined && ![0, 200, '0', '200'].includes(d.code)) throw new ChannelError(502);
    return d.data ?? d;
  };
  return {
    models: async auth => {
      const release = await call('https://zcode.z.ai/api/v1/client/configs?' + new URLSearchParams({ app_version: '3.16.3', platform: process.platform }));
      const url = new URL(token(release.configs?.builtin_provider_config_json));
      if (url.protocol !== 'https:' || url.username || url.password) throw new ChannelError(502);
      const config = (await json(fetcher, url)).config;
      const plan = auth.site === 'bigmodel' ? 'account:bigmodel-individual-coding-plan' : 'account:zai-individual-coding-plan';
      const ids = new Set<string>((config?.providerConfigRules?.providerRules || []).filter((r: Json) => r.providerId === plan).flatMap((r: Json) => r.builtinModelIds || []));
      for (const rule of config?.modelConfigRules?.builtinProviderModelRules || []) if (rule.providerId === plan) {
        if (rule.config?.enabled === false) ids.delete(rule.modelId); else ids.add(rule.modelId);
      }
      return modelRows([...ids].map(id => ({ id })));
    },
    auth: {
      methods: [{ type: 'oauth', label: 'ZCode GLM Coding Plan 授权', prompts: [{ key: 'site', type: 'select', message: '账号平台', options: [{ label: '智谱国内', value: 'bigmodel' }, { label: 'Z.ai', value: 'zai' }] }], authorize: async (input = {}) => {
        const site = input.site === 'zai' ? 'zai' : 'bigmodel'; const device = randomUUID();
        const headers = { authorization: 'Bearer ' + randomBytes(32).toString('hex'), 'X-Device-Mid': device, 'user-agent': 'ZCode/3.16.3' };
        const flow = await call('https://zcode.z.ai/api/v1/oauth/cli/init', post({ provider: site }, headers));
        const url = new URL(token(flow.authorize_url));
        url.searchParams.set(site === 'bigmodel' ? 'redirect' : 'redirect_uri', 'https://zcode.z.ai/app/oauth/login?' + new URLSearchParams({ redirect: 'zcode://oauth/callback', app_version: '3.16.3' }));
        return { url: url.href, method: 'auto', callback: async () => {
          const result = await poll(async () => {
            const got = await call('https://zcode.z.ai/api/v1/oauth/cli/poll/' + encodeURIComponent(token(flow.flow_id)), { headers });
            if (!got.status || got.status === 'pending') return undefined;
            if (got.status !== 'ready') throw new Error('SUBSCRIPTION_LOGIN_FAILED'); return got;
          }, Math.max(1000, Number(flow.poll_interval_sec || 2) * 1000), Math.min(600000, Number(flow.expires_at) * 1000 - Date.now() || 300000));
          let access = token(result[site]?.access_token || result[site]?.accessToken);
          const root = site === 'zai' ? 'https://api.z.ai' : 'https://bigmodel.cn';
          if (site === 'zai') access = 'Bearer ' + token((await call(root + '/api/auth/z/login', post({ token: access }))).access_token);
          const authHeaders = { authorization: access };
          const customer = await call(root + '/api/biz/customer/getCustomerInfo', { headers: authHeaders });
          const projects = (customer.organizations || []).flatMap((o: Json) => (o.projects || []).filter((p: Json) => p.projectId && String(p.projectType) !== '2').map((p: Json) => ({ org: o.organizationId, project: p.projectId, preferred: String(o.organizationName).includes('默认') && String(p.projectName).includes('默认') })));
          const selected = projects.find((p: Json) => p.preferred) || (projects.length === 1 ? projects[0] : undefined);
          if (!selected) throw new Error('SUBSCRIPTION_ACCOUNT_AMBIGUOUS');
          const keys = root + `/api/biz/v1/organization/${encodeURIComponent(selected.org)}/projects/${encodeURIComponent(selected.project)}/api_keys`;
          const rows = await call(keys, { headers: authHeaders });
          let id = Array.isArray(rows) ? rows.find((k: Json) => k.name === 'jusage-api-key')?.apiKey : undefined;
          if (!id) id = (await call(keys, post({ name: 'jusage-api-key' }, authHeaders))).apiKey;
          const secret = await call(keys + '/copy/' + encodeURIComponent(token(id)), { headers: authHeaders });
          return { type: 'api', key: token(id) + '.' + token(secret.secretKey), site, uid: String(result.user?.user_id || ''), accountName: result.user?.email || result.user?.name };
        } };
      } }],
      transport: async getAuth => ({ fetch: async (_url, init) => {
        const a = await getAuth(); const root = a.site === 'bigmodel' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
        return fetcher(root + '/api/anthropic/v1/messages', { ...init, redirect: 'error', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${token(a.key)}` } });
      } }),
    },
  };
}

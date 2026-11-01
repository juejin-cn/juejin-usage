import { randomUUID } from 'node:crypto';
import type { SubscriptionChannel } from '../subscription-types.js';
import { json, modelRows, type Json } from './http.js';
export function zenFreeChannel(fetcher: typeof fetch = fetch): SubscriptionChannel {
  let allowed = new Set<string>(); let checkedAt = 0;
  const models = async () => {
    const [catalog, available] = await Promise.all([
      json(fetcher, 'https://models.opencode.ai/api.json'),
      json(fetcher, 'https://opencode.ai/inference/v1/models', { headers: { authorization: 'Bearer public' } }),
    ]);
    const provider = catalog.opencode;
    const rows = (available.data || []).filter((m: Json) => {
      const meta = provider?.models?.[m.id];
      const npm = meta?.provider?.npm || provider?.npm;
      return meta && meta.cost?.input === 0 && meta.cost?.output === 0 && !meta.deprecated && !['deprecated', 'retired', 'disabled'].includes(meta.status) && (!npm || npm.includes('openai-compatible'));
    });
    const result = modelRows(rows); allowed = new Set(Object.keys(result)); checkedAt = Date.now(); return result;
  };
  return { models, auth: {
    methods: [{ type: 'oauth', label: '启用免费渠道', authorize: async () => ({ type: 'oauth', source: 'zen-public' }) }],
    transport: async () => ({ baseURL: 'https://opencode.ai/inference/openai/v1', fetch: async (url, init) => {
      if (Date.now() - checkedAt > 300000) await models(); const body = JSON.parse(String(init?.body || '{}'));
      if (!allowed.has(body.model)) return Response.json({ error: { message: 'SUBSCRIPTION_FREE_MODEL_UNAVAILABLE' } }, { status: 404 });
      const session = new Headers(init?.headers).get('x-jusage-session') || randomUUID();
      // Keep the caller's actual tool contract: never advertise tools it cannot run.
      return fetcher(url, { ...init, redirect: 'error', headers: { 'content-type': 'application/json', authorization: 'Bearer public', 'user-agent': 'opencode/latest/2.2.5/cli',
        'x-opencode-client': 'cli', 'x-opencode-session': session, 'x-opencode-session-id': session, 'x-session-affinity': session, 'x-session-id': session } });
    } }),
  } };
}

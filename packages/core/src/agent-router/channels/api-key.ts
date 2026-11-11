import { nameOnlyMetadata } from './model-metadata.js';
import type { SubscriptionChannel } from '../subscription-types.js';
import { json, modelRows, token, quotaResponse } from './http.js';

/** Paid products keep their own endpoint and credentials, separate from free/API plans. */
export function apiKeyChannel(id: 'opencode-go' | 'volcengine', fetcher: typeof fetch = fetch): SubscriptionChannel {
  const go = id === 'opencode-go';
  const baseURL = go ? 'https://opencode.ai/inference/go/openai/v1' : 'https://ark.cn-beijing.volces.com/api/coding/v3';
  return {
    models: async auth => go
      ? modelRows((await json(fetcher, 'https://opencode.ai/inference/go/v1/models')).data.filter((m: any) => m.api?.['chat-completions']?.base_url === baseURL), 'id', nameOnlyMetadata)
      : modelRows(String(auth.models).split(',').map(id => ({ id: id.trim() })).filter(row => row.id), 'id', nameOnlyMetadata),
    auth: {
      methods: (go ? ['go'] : ['coding', 'api']).map(plan => ({ type: 'api', label: go ? 'OpenCode Go API Key' : plan === 'coding' ? '火山方舟 Coding Plan API Key' : '火山方舟按量 API Key', prompts: [
        { key: 'key', type: 'password', message: 'API Key' },
        ...(!go ? [{ key: 'models', type: 'text', message: '模型 ID（多个用英文逗号分隔）', placeholder: 'doubao-seed-code' }] : []),
      ], authorize: async (input = {}) => {
        const key = token(input.key?.trim());
        if (!go && !input.models?.trim()) throw new Error('SUBSCRIPTION_INPUT_INVALID');
        return { type: 'api', key, ...(!go ? { models: input.models.trim(), plan } : {}) };
      } })),
      transport: async getAuth => ({ baseURL: !go && (await getAuth()).plan === 'api' ? 'https://ark.cn-beijing.volces.com/api/v3' : baseURL, fetch: async (url, init) => quotaResponse(await fetcher(url, {
        ...init, redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token((await getAuth()).key)}` },
      })) }),
    },
  };
}

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, json, jwt, modelRows, token } from './http.js';
import { accountHash, readLocalJson } from './local-auth.js';

export function grokChannel(fetcher: typeof fetch = fetch, path = () => join(process.env.GROK_HOME || join(homedir(), '.grok'), 'auth.json')): SubscriptionChannel {
  const current = async (a?: SubscriptionAuth) => {
    const entries = Object.values(await readLocalJson(path()));
    for (const value of entries) {
      if (!value || typeof value !== 'object' || typeof value.key !== 'string') continue;
      const uid = accountHash(token(value.user_id || jwt(value.key).sub || value.email));
      if (a && a.uid !== uid) continue;
      if (value.expires_at && Date.parse(value.expires_at) <= Date.now()) throw new ChannelError(401);
      return { uid, access: token(value.key), accountName: value.email || value.user_id };
    }
    throw new ChannelError(401);
  };
  const headers = async (a: SubscriptionAuth) => ({ authorization: `Bearer ${(await current(a)).access}`, 'content-type': 'application/json',
    'x-grok-client-version': '1.0.41', 'x-xai-token-auth': 'xai-grok-cli', 'x-grok-client-identifier': 'grok-shell', 'x-grok-client-mode': 'headless',
    'user-agent': `grok-shell/1.0.41 (${process.platform}; ${process.arch})` });
  return {
    models: async a => modelRows((await json(fetcher, 'https://cli-chat-proxy.grok.com/v1/models', { headers: await headers(a) })).data?.filter((m: any) => !m.api_backend || m.api_backend === 'responses')),
    auth: {
      account: async getAuth => ({ accountName: (await current(await getAuth())).accountName }),
      methods: [{ type: 'oauth', label: '读取 Grok CLI 本机登录', authorize: async () => { const a = await current(); return { type: 'oauth', source: 'grok-local', uid: a.uid, accountName: a.accountName }; } }],
      transport: async getAuth => ({ baseURL: 'https://cli-chat-proxy.grok.com/v1', fetch: async (url, init) => fetcher(url, { ...init, redirect: 'error', headers: await headers(await getAuth()) }) }),
    },
  };
}

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { kimiDesktopShareDir } from '../../paths.js';
import type { SubscriptionChannel, SubscriptionAuth } from '../subscription-types.js';
import { ChannelError, json, modelRows, record, token, quotaResponse } from './http.js';
const root = 'https://agent-gw.kimi.com/coding/v1';
export function kimiWorkChannel(fetcher: typeof fetch = fetch, directory = () => join(kimiDesktopShareDir(), 'daimon')): SubscriptionChannel {
  const read = async (name: string) => { const path = join(directory(), name); if ((await stat(path)).size > 8 * 1024 * 1024) throw new ChannelError(401); return record(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))); };
  const identify = (uid: string) => createHash('sha256').update(uid).digest('hex');
  const current = async (a?: SubscriptionAuth) => {
    const d = await read('config.json'); const web = d.credentials?.kimiWeb; const code = d.credentials?.kimiCode;
    const uid = identify(token(web?.userId)); let key = code?.apiKey; let accountId = web.userId;
    if (code?.baseUrl?.replace(/\/$/, '') !== root) throw new ChannelError(401);
    if (a && a.uid !== uid) {
      const saved = await read('kimi-code-key.json');
      const entry = saved.v === 2 ? saved.keys?.find((k: any) => typeof k.userId === 'string' && identify(k.userId) === a.uid) : undefined;
      key = entry?.apiKey; accountId = entry?.userId;
    }
    return { uid: a?.uid || uid, key: token(key), accountId };
  };
  const headers = async (a: SubscriptionAuth) => ({ authorization: `Bearer ${(await current(a)).key}`, 'content-type': 'application/json',
    'user-agent': 'kimi-code-cli/0.36.0', 'X-Msh-Platform': 'kimi-code-cli', 'X-Msh-Version': '0.36.0', 'X-Msh-Daimon-Version': '0.6.10' });
  return {
    models: async a => modelRows((await json(fetcher, root + '/models', { headers: await headers(a) })).data),
    auth: {
      account: async getAuth => ({ accountId: (await current(await getAuth())).accountId }),
      methods: [{ type: 'oauth', label: '读取 Kimi Work 本机登录', authorize: async () => ({ type: 'oauth', source: 'kimi-work-local', uid: (await current()).uid }) }],
      transport: async getAuth => ({ baseURL: root, fetch: async (url, init) => quotaResponse(await fetcher(url, { ...init, redirect: 'error', headers: await headers(await getAuth()) })) }),
    },
  };
}

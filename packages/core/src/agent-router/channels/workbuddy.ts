import { portableHarnessGuidance } from './workbuddy-prompts.js';
import { portableClientIdentity } from '../protocol/client-identity.js';
import { workbuddyMetadata } from './model-metadata.js';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, type Json, json, modelRows, poll, post, record, token, quotaResponse } from './http.js';

/** WorkBuddy rejects these fixed client identity prefixes. Keep every following
 * instruction and tool schema; never rewrite user messages or arbitrary prose. */
function portableMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map(message => {
    // This upstream accepts system instructions but rejects the newer
    // developer role emitted by Responses clients, including Codex.
    if (message?.role === 'developer') message = { ...message, role: 'system' };
    if (message?.role !== 'system') return message;
    const rewrite = (text: string) => portableHarnessGuidance(portableClientIdentity(text));
    const content = typeof message.content === 'string' ? rewrite(message.content) : Array.isArray(message.content) ? message.content.map((part: Json) =>
      part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: rewrite(part.text) } : part) : message.content;
    return content !== message.content ? { ...message, content } : message;
  });
}

export function workbuddyChannel(global: boolean, fetcher: typeof fetch = fetch): SubscriptionChannel {
  const root = global ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com';
  const platform = global ? 'workbuddy-ai' : 'workbuddy';
  const salt = randomBytes(32);
  const digest = (v: unknown) => createHmac('sha256', salt).update(JSON.stringify(v)).digest('hex').slice(0, 32);
  const headers = (a: SubscriptionAuth): Record<string, string> => ({
    authorization: `Bearer ${token(a.access ?? a.key)}`, 'X-User-Id': a.type === 'api' ? `anonymous_${token(a.key).slice(-8)}` : String(a.uid || ''),
    ...(a.type === 'api' ? { 'X-API-Key': token(a.key) } : { 'X-Domain': String(a.domain || new URL(root).hostname) }),
    ...(a.enterpriseId ? { 'X-Enterprise-Id': String(a.enterpriseId), 'X-Tenant-Id': String(a.enterpriseId) } : {}),
    'X-Product': 'SaaS', 'X-IDE-Type': 'WorkBuddy', 'X-IDE-Name': 'WorkBuddy', 'X-IDE-Version': '5.9.3',
    'X-Agent-Intent': 'craft', 'X-Agent-Purpose': 'conversation', 'X-Requested-With': 'XMLHttpRequest',
    'user-agent': `WorkBuddy/5.9.3 ${global ? 'workbuddy-ai' : 'WorkBuddy'}/5.9.3 CLI/2.165.0`,
  });
  const call = async (path: string, init: RequestInit = {}, pending: number[] = []): Promise<Json | undefined> => {
    const result = await json(fetcher, root + path, init);
    if (pending.includes(result.code)) return undefined;
    if (result.code && result.code !== 0) throw new ChannelError([401, 11201, 11202].includes(result.code) ? 401 : 502);
    return record(result.data);
  };
  const credentials = (d: Json, previous: SubscriptionAuth = {}): SubscriptionAuth => ({ ...previous, type: 'oauth', access: token(d.accessToken),
    refresh: d.refreshToken || previous.refresh || '', expires: d.expiresAt || Date.now() + Number(d.expiresIn || 3600) * 1000,
    domain: d.domain || previous.domain || new URL(root).hostname });
  return {
    models: async auth => {
      const cfg = (await call('/v3/config', { headers: headers(auth) }))!;
      const ids = new Set((cfg.agents || []).filter((a: Json) => a.name === 'cli').flatMap((a: Json) => a.models || []));
      return modelRows((cfg.models || []).filter((m: Json) => ids.has(m.id)), 'id', m => workbuddyMetadata(m, cfg.modelPromotions));
    },
    auth: {
      usage: async getAuth => {
        const a = await getAuth();
        if (a.type === 'api') return {};
        const summary = (await call('/billing/meter/get-user-resource-summary', post({}, headers(a))))!;
        const amount = (value: unknown): number => {
          if (value === undefined || value === null || value === '') return 0;
          const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
          if (!Number.isFinite(n) || n < 0) throw new ChannelError(502, 'SUBSCRIPTION_INVALID_RESPONSE');
          return n;
        };
        const windows: Array<{ amount?: number; limit?: number; balance?: number; used?: number; unit: string; resetsAt?: string }> = [];
        let limit = 0, spent = 0, extra = 0, hasExtra = false;
        if (summary.Packages !== undefined && !Array.isArray(summary.Packages)) throw new ChannelError(502, 'SUBSCRIPTION_INVALID_RESPONSE');
        for (const value of summary.Packages ?? []) {
          const pack = record(value);
          if (pack.CycleTotalCapacity != null && pack.CycleTotalCapacity !== '') {
            limit += amount(pack.CycleTotalCapacity); spent += amount(pack.CycleUsedCapacity);
          } else if (pack.CycleRemainCapacity != null && pack.CycleRemainCapacity !== '') {
            extra += amount(pack.CycleRemainCapacity); hasExtra = true;
          }
        }
        if (limit > 0) windows.push({ amount: spent, limit, used: Math.min(100, spent / limit * 100), unit: 'credits' });
        if (hasExtra && (extra > 0 || !windows.length)) windows.push({ balance: extra, unit: 'credits' });
        let plan = summary.IsPaidUser ? 'Pro' : 'Free';
        if (!windows.length && a.enterpriseId) {
          const enterprise = (await call('/billing/meter/get-enterprise-user-usage', post({}, headers(a))))!;
          const total = amount(enterprise.limitNum), used = amount(enterprise.credit);
          const reset = typeof enterprise.cycleResetTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(enterprise.cycleResetTime)
            ? Date.parse(enterprise.cycleResetTime.replace(' ', 'T') + '+08:00') : NaN;
          if (total > 0) windows.push({ amount: used, limit: total, used: Math.min(100, used / total * 100), unit: 'credits', ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}) });
          plan = 'Enterprise';
        }
        return { plan, windows };
      },
      account: async getAuth => {
        const a = await getAuth(); if (a.type === 'api') return {};
        const data = (await call('/v2/plugin/accounts', { headers: headers(a) }))!;
        const who = data.accounts?.find((value: Json) => value.uid === a.uid && (value.enterpriseId || '') === (a.enterpriseId || ''));
        if (!who) throw new Error('SUBSCRIPTION_ACCOUNT_UNAVAILABLE');
        return { accountName: who.nickname || who.phoneNumber || who.uid, accountId: who.uid, email: who.email };
      },
      refreshLead: 300000,
      refresh: async a => credentials((await call('/v2/plugin/auth/token/refresh', post({}, { 'X-Refresh-Token': token(a.refresh), 'X-Auth-Refresh-Source': 'plugin', 'X-Domain': String(a.domain || new URL(root).hostname), ...(a.enterpriseId ? { 'X-Enterprise-Id': String(a.enterpriseId), 'X-Tenant-Id': String(a.enterpriseId) } : {}) })))!, a),
      methods: [{ type: 'oauth', label: 'WorkBuddy 浏览器授权', authorize: async () => {
        const start = (await call(`/v2/plugin/auth/state?platform=${platform}`, post({}, { 'X-No-Authorization': 'true', 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' })))!;
        const url = new URL(token(start.authUrl)); url.searchParams.set('version', '5.9.3'); url.searchParams.set('loginSessionId', randomUUID());
        return { url: url.href, method: 'auto', callback: async () => {
          const state = encodeURIComponent(token(start.state));
          const a = credentials(await poll(() => call(`/v2/plugin/auth/token?state=${state}`, {}, [11217])));
          const who = await poll(() => call(`/v2/plugin/login/account?state=${state}`, { headers: { ...headers(a), 'X-No-User-Id': 'true', 'X-No-Enterprise-Id': 'true' } }, [12151]));
          let enterpriseId = who.enterpriseId;
          if (!enterpriseId && who.type && who.type !== 'personal') {
            const accounts = (await call('/v2/plugin/accounts', { headers: headers(a) }))!.accounts;
            const candidates = accounts?.filter((v: Json) => v.uid === who.uid && v.enterpriseId && v.type === who.type);
            if (candidates?.length !== 1) throw new Error('SUBSCRIPTION_ACCOUNT_AMBIGUOUS');
            enterpriseId = candidates[0].enterpriseId;
          }
          return { ...a, uid: token(who.uid), enterpriseId: enterpriseId || '', accountName: who.nickname || who.phoneNumber || who.uid };
        } };
      } }, { type: 'api', label: 'WorkBuddy API Key', prompts: [{ key: 'key', type: 'text', message: 'API Key', validate: v => v.trim() ? undefined : 'required' }] }],
      transport: async getAuth => ({ baseURL: root + '/v2', fetch: async (url, init) => {
        const a = await getAuth(); const body = JSON.parse(String(init?.body || '{}'));
        const users = (body.messages || []).filter((m: Json) => m.role === 'user');
        const conversation = digest(new Headers(init?.headers).get('x-jusage-session') || users[0] || randomUUID());
        const turn = digest([conversation, users.length, users.at(-1)]);
        return quotaResponse(await fetcher(url, { ...init, redirect: 'error', body: JSON.stringify({ ...body, messages: portableMessages(body.messages), stream: true }), headers: {
          ...headers(a), 'content-type': 'application/json', 'X-Agent-Type': 'main', 'X-Agent-Runtime': 'local-agent',
          'X-Conversation-ID': conversation, 'X-Conversation-Request-ID': turn, 'X-Request-ID': randomUUID(),
        } }));
      } }),
    },
  };
}

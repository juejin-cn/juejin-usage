import { constants, createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, type Json, expires, httpsOrigin, json, modelRows, poll, post, readJson, record, token } from './http.js';
import { eventResponse, sse } from './streams.js';
import { TextToolDecoder } from './text-tools.js';
// Public service key used only to wrap a fresh per-request encryption key.
const serviceKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const wire = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$';
export function encodeQoderBody(value: unknown): string {
  const text = [...Buffer.from(JSON.stringify(value)).toString('base64')].map(c => wire[standard.indexOf(c)]).join('');
  const n = Math.floor(text.length / 3); return n ? text.slice(-n) + text.slice(n, -n) + text.slice(0, n) : text;
}
type SiteId = 'qoder' | 'qoder-cn' | 'qwenwork' | 'qwenwork-enterprise';
export function qoderChannel(id: SiteId, fetcher: typeof fetch = fetch): SubscriptionChannel {
  const qwen = id.startsWith('qwenwork'); const international = id === 'qoder';
  const version = qwen ? '1.1.59' : '1.1.69'; const product = qwen ? 'qoder_work' : 'app';
  const clientId = international ? '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa' : 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
  const site = (a: SubscriptionAuth = {}) => id === 'qwenwork-enterprise' ? { web: httpsOrigin(token(a.host)), api: httpsOrigin(token(a.host)), auth: httpsOrigin(token(a.host)) }
    : qwen ? { web: 'https://gateway.qwenwork.cn', auth: 'https://gateway.qwenwork.cn', api: 'https://gateway.qwenwork.cn' }
      : international ? { web: 'https://qoder.com', auth: 'https://openapi.qoder.sh', api: 'https://api3.qoder.sh' }
        : { web: 'https://qoder.cn', auth: 'https://openapi.qoder.com.cn', api: 'https://gateway.qoder.com.cn' };
  const credentials = (d: Json, a: SubscriptionAuth): SubscriptionAuth => ({ ...a, type: 'oauth', access: token(d.token || d.device_token), refresh: d.refresh_token || a.refresh || '',
    expires: expires(d.expires_at || d.expire_time, Date.now() + Number(d.expires_in || (a.deviceChat ? 86400 : 86400000)) * (a.deviceChat ? 1000 : 1)) });
  const sign = (a: SubscriptionAuth, path: string, body: string): Record<string, string> => {
    const key = Buffer.from(randomBytes(8).toString('hex')); const cipher = createCipheriv('aes-128-cbc', key, key);
    const info = Buffer.concat([cipher.update(JSON.stringify({ uid: a.uid, aid: '', name: a.name || '', email: a.email || '', security_oauth_token: token(a.access) })), cipher.final()]).toString('base64');
    const wrapped = publicEncrypt({ key: serviceKey, padding: constants.RSA_PKCS1_PADDING }, key).toString('base64');
    const payload = Buffer.from(JSON.stringify({ version: 'v1', requestId: randomUUID(), info, cosyVersion: version, ideVersion: '' })).toString('base64');
    const time = String(Math.floor(Date.now() / 1000));
    const signature = createHash('md5').update([payload, wrapped, time, body, path.split('?')[0].replace(/^\/algo/, '')].join('\n')).digest('hex');
    return { authorization: `Bearer COSY.${payload}.${signature}`, 'content-type': 'application/json', 'accept-encoding': 'identity',
      'Cosy-Key': wrapped, 'Cosy-Date': time, 'Cosy-User': token(a.uid), 'Cosy-MachineId': token(a.machineId),
      'Cosy-MachineOS': `${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}_${process.platform}`,
      'Cosy-Business-Product': product, 'Cosy-Business-Type': 'agent', 'Cosy-ClientType': qwen ? '6' : '10', 'Cosy-Data-Policy': 'disagree', 'Cosy-Scene': qwen ? 'qwork' : 'app', 'Cosy-Version': version, 'Login-Version': 'v2' };
  };
  let catalog: Json[] = []; let catalogAt = 0;
  const listing = async (a: SubscriptionAuth) => {
    const path = '/algo/api/v2/model/list?Encode=1';
    const data: Json = await json(fetcher, site(a).api + path, { headers: { ...sign(a, path, ''), 'Cosy-MachineToken': token(a.machineId), 'Cosy-MachineType': '5' } }).catch(error => {
      if (id !== 'qwenwork-enterprise' || !(error instanceof ChannelError) || error.status !== 503) throw error;
      // Enterprise deployments may omit the catalog service; these are the
      // public product's routing aliases, not guessed underlying model IDs.
      return { qwork: [{ key: 'flash', display_name: '标准' }, { key: 'pro', display_name: '高级' }] };
    });
    const rows = qwen ? data.qwork : [...(data.app || []), ...(data.chat || [])];
    if (!Array.isArray(rows)) throw new ChannelError(502, 'SUBSCRIPTION_MODELS_FAILED');
    catalog = rows.filter(m => (qwen || m.enable) && m.key && !['auto', 'default'].includes(m.key)); catalogAt = Date.now(); return catalog;
  };
  return {
    models: async a => modelRows((await listing(a)).map(m => ({ ...m, id: m.key }))),
    auth: {
      ...(!qwen ? { usage: async (getAuth: () => Promise<SubscriptionAuth>) => {
        const a = await getAuth();
        // Older accounts only saved the chat credential. Try it without
        // rotating it or changing the gateway's authentication state.
        const access = a.deviceChat ? a.access : a.deviceToken || a.access;
        let data: Json;
        try {
          data = await json(fetcher, site(a).auth + '/sash/api/v2/me/usage', { headers: {
            authorization: `Bearer ${token(access)}`, accept: 'application/json', 'Cosy-ClientType': '10', 'user-agent': 'Qoder',
          } });
        } catch (error) {
          if (error instanceof ChannelError && [401, 403].includes(error.status)) throw new Error('SUBSCRIPTION_QUOTA_AUTH_REQUIRED');
          throw error;
        }
        if (data.displayMode === 'enterprise') return { plan: 'Enterprise', windows: [] };
        if (data.displayMode !== 'qoder') throw new ChannelError(502, 'SUBSCRIPTION_INVALID_RESPONSE');
        const quota = record(data.qoderUsage);
        const windows: Array<{ amount?: number; limit?: number; balance?: number; used?: number; unit: string }> = [];
        const pools = [quota.userQuota ?? quota.user_quota, quota.addOnQuota ?? quota.add_on_quota, quota.orgResourcePackage ?? quota.org_resource_package];
        const dedicated = quota.dedicatedResourcePackages ?? quota.dedicated_resource_packages;
        if (Array.isArray(dedicated)) pools.push(...dedicated);
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
        for (const pool of pools) {
          if (!pool || typeof pool !== 'object' || Array.isArray(pool)) continue;
          const limit = number(pool.total ?? pool.cap), spent = number(pool.used), balance = number(pool.remaining);
          if (limit === undefined || (limit > 0 && spent === undefined && balance === undefined)) continue;
          const amount = spent ?? Math.max(0, limit - (balance ?? 0));
          windows.push({ amount, limit, balance: balance ?? Math.max(0, limit - amount), used: limit > 0 ? Math.min(100, amount / limit * 100) : 100, unit: pool.unit || 'credits' });
        }
        const rawPlan = quota.userType ?? quota.user_type;
        const plan = ({ personal_standard: 'Free', personal_professional: 'Pro', personal_professional_trial: 'Trial' } as Record<string, string>)[rawPlan] ?? rawPlan;
        return { plan, windows };
      } } : {}),
      refreshLead: 300000,
      refresh: async a => credentials(await json(fetcher, site(a).auth + `/api/v1/${a.deviceChat ? 'deviceToken' : 'jobToken'}/refresh`, post({ refresh_token: token(a.refresh), ...(qwen ? { target: 'c' } : {}) })), a),
      methods: [{ type: 'oauth', label: '设备授权', ...(id === 'qwenwork-enterprise' ? { prompts: [{ key: 'host', type: 'text', message: '企业千问办公 HTTPS 域名' }] } : {}), authorize: async (input = {}) => {
        const a: SubscriptionAuth = { host: id === 'qwenwork-enterprise' ? httpsOrigin(input.host) : undefined, machineId: randomUUID(), deviceChat: qwen };
        const endpoint = site(a); const verifier = randomBytes(48).toString('base64url'); const nonce = randomUUID();
        const params = new URLSearchParams({ client_id: clientId, nonce, machine_id: String(a.machineId), challenge_method: 'S256', challenge: createHash('sha256').update(verifier).digest('base64url') });
        if (id === 'qwenwork') params.set('redirect_uri', 'qwenwork-cn://');
        return { url: endpoint.web + '/device/selectAccounts?' + params, method: 'auto', callback: async () => {
          const device = await poll(async () => {
            const r = await fetcher(endpoint.auth + '/api/v1/deviceToken/poll?' + new URLSearchParams({ nonce, verifier, challenge_method: 'S256' }), { redirect: 'error', signal: AbortSignal.timeout(30000) });
            if ([202, 204, 404].includes(r.status)) { await r.body?.cancel(); return undefined; }
            if (!r.ok) { await r.body?.cancel(); throw new ChannelError(r.status); }
            const d = record(await readJson(r)); return d.token ? d : undefined;
          });
          let issued = device;
          if (!qwen) {
            try { issued = await json(fetcher, endpoint.auth + '/api/v1/me/jobToken', post({ clientId }, { authorization: `Bearer ${token(device.token)}` })); }
            catch (error) { if (id === 'qoder-cn' && error instanceof ChannelError && error.status >= 400 && error.status < 500) a.deviceChat = true; else throw error; }
          }
          const who = await json(fetcher, endpoint.auth + (qwen ? '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing' : '/api/v1/userinfo'), { headers: { authorization: `Bearer ${token(device.token)}` } });
          const user = qwen ? who.data?.user || who.user : who;
          return credentials(issued, { ...a, deviceToken: token(device.token), deviceRefresh: device.refresh_token || '', uid: String(user?.id || user?.user_id || user?.uid || device.user_id || ''), email: user?.email || '', name: user?.name || '', accountName: user?.email || user?.name || device.user_id });
        } };
      } }],
      transport: async getAuth => ({ fetch: async (_url, init) => {
        const controller = new AbortController();
        init = { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal };
        const a = await getAuth(); if (!catalog.length || Date.now() - catalogAt > 300000) await listing(a);
        const request = record(JSON.parse(String(init?.body || '{}'))); const model = catalog.find(m => m.key === request.model);
        if (!model) return Response.json({ error: { message: 'SUBSCRIPTION_MODEL_UNAVAILABLE' } }, { status: 404 });
        const session = new Headers(init?.headers).get('x-jusage-session') || randomUUID();
        const task = createHash('sha256').update(session).digest('hex').slice(0, 32); const reqId = randomUUID();
        const messages = (request.messages || []).filter((m: Json) => !['system', 'developer'].includes(m.role));
        const system = (request.messages || []).filter((m: Json) => ['system', 'developer'].includes(m.role)).flatMap((m: Json) => typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
        const payload = { request_id: reqId, request_set_id: task, chat_record_id: reqId, session_id: session,
          parameters: { enable_thinking: !!model.is_reasoning, max_tokens: request.max_completion_tokens || request.max_tokens || 32000, ...(request.reasoning_effort ? { reasoning_effort: request.reasoning_effort } : {}) },
          business: { product, version, type: 'agent', id: task, name: '', begin_at: Date.now(), stage: messages.some((m: Json) => m.role === 'assistant') ? 'processing' : 'start' },
          agent_id: 'agent_common', task_id: 'common', session_type: product, model_config: model, system, messages: [{ role: 'system', content: system }, ...messages],
          ...(request.tool_choice !== 'none' && request.tools ? { tools: request.tools } : {}) };
        const body = encodeQoderBody(payload); const path = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
        const response = await fetcher(site(a).api + path, { ...init, method: 'POST', redirect: 'error', body, headers: { ...sign(a, path, body), accept: 'text/event-stream', 'X-Model-Key': model.key, 'X-Model-Source': model.source || '' } });
        if (!response.ok || !response.body) return response;
        return eventResponse((async function* () {
          let finished = false; let finishChunk: Json | undefined; let calls = 0;
          const decoder = new TextToolDecoder(request.tools || []); const nativeIndices = new Map<number, number>();
          const pieces = (chunk: Json, text: string, end = false) => decoder.feed(text, end).map(part => {
            const delta = part.name ? { tool_calls: [{ index: calls++, id: 'call_' + randomUUID(), type: 'function', function: { name: part.name, arguments: part.arguments } }] } : { content: part.text };
            return { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] };
          });
          for await (const data of sse(response.body!)) {
            const envelope = record(JSON.parse(data));
            if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
              let error: Json = {}; try { error = JSON.parse(envelope.body); } catch {}
              const code = String(error.code || error.errorCode || '');
              throw new ChannelError(code === '105' ? 401 : ['110','112','113','114','115','116','117','118','119','122','10605'].includes(code) ? 429 : 502);
            }
            if (envelope.body?.trim() === '[DONE]') { finished = true; break; }
            const chunk = record(JSON.parse(envelope.body)); const choice = chunk.choices?.[0];
            if (choice?.delta?.content) { yield* pieces(chunk, choice.delta.content); delete choice.delta.content; }
            for (const call of choice?.delta?.tool_calls || []) { const index = Number(call.index || 0); if (!nativeIndices.has(index)) nativeIndices.set(index, calls++); call.index = nativeIndices.get(index); }
            if (choice?.finish_reason) { finished = true; finishChunk = chunk; }
            else if (!choice || Object.keys(choice.delta || {}).length || chunk.usage) yield chunk;
          }
          if (!finished) throw new ChannelError(502, 'SUBSCRIPTION_TRUNCATED_STREAM');
          const last = finishChunk || { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion.chunk', model: request.model };
          yield* pieces(last, '', true);
          yield { ...last, choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : finishChunk?.choices?.[0]?.finish_reason || 'stop' }] }; yield '[DONE]';
        })(), () => controller.abort());
      } }),
    },
  };
}

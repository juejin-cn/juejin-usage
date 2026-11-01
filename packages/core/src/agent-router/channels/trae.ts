import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, type Json, expires, json, modelRows, post, token, quotaResponse } from './http.js';
import { eventResponse, sseEvents } from './streams.js';
import { TextToolDecoder } from './text-tools.js';

export function traeChannel(global: boolean, fetcher: typeof fetch = fetch): SubscriptionChannel {
  const web = global ? 'https://www.trae.ai' : 'https://www.trae.cn';
  const authRoot = global ? 'https://growsg-normal.trae.ai' : 'https://api.trae.cn';
  const api = (a: SubscriptionAuth) => global ? a.region === 'us' ? 'https://coreva-normal.trae.ai' : 'https://coresg-normal.trae.ai' : 'https://trae-api-cn.mchost.guru';
  const headers = (a: SubscriptionAuth) => ({ 'content-type': 'application/json', authorization: `Cloud-IDE-JWT ${token(a.access)}`, 'X-Cloudide-Token': token(a.access), 'x-ide-token': token(a.access),
    'x-uid': token(a.uid), 'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8', 'x-device-id': token(a.deviceId), 'x-machine-id': token(a.machineId), 'x-request-id': randomUUID(),
    'x-app-version': '0.1.69', 'x-app-version-code': '20260917', 'x-ide-version': '0.1.69', 'x-ide-version-code': '20260917', 'x-ide-version-type': 'stable', 'x-system-type': process.platform });
  const credentials = (d: Json, a: SubscriptionAuth = {}): SubscriptionAuth => ({ ...a, type: 'oauth', access: token(d.Token || d.token), refresh: d.RefreshToken || d.refreshToken || a.refresh || '', expires: expires(d.TokenExpireAt || d.tokenExpireAt), clientId: d.ClientID || a.clientId || 'ono9krqynydwx5' });
  const refresh = async (a: SubscriptionAuth): Promise<SubscriptionAuth> => {
    const d = await json(fetcher, authRoot + '/cloudide/api/v3/trae/oauth/ExchangeToken', post({ ClientID: a.clientId || 'ono9krqynydwx5', RefreshToken: token(a.refresh), ClientSecret: '-', UserID: '' }));
    return credentials(d.Result || d.result || d, a);
  };
  let catalog = new Map<string, Json>();
  const models = async (a: SubscriptionAuth) => {
    const result = new Map<string, Json>();
    const calls = await Promise.allSettled(['chat_v3', 'solo_work_lite', 'solo_agent', 'solo_agent_lite', 'solo_coder'].map(async fn => {
      const d = await json(fetcher, api(a) + '/api/ide/v1/get_detail_param', post({ function: fn, config_names: null, need_prompt: false, current_config_info: null, poly_prompt: true, mode_type: null, agent_type: null }, headers(a)));
      return (d.config_info_list || d.data?.config_info_list || []).map((m: Json) => ({ ...m, fn }));
    }));
    for (const r of calls) if (r.status === 'fulfilled') for (const m of r.value) {
      if (!m.config_name || m.config_switch === false || m.is_custom_model || /^custom_model/i.test(m.config_name) || m.usage && m.usage !== 'chat_completion' || global && m.is_invisible_to_user) continue;
      if (!result.has(m.config_name)) result.set(m.config_name, m);
    }
    if (!result.size) throw new Error('SUBSCRIPTION_MODELS_FAILED'); catalog = result;
    return modelRows([...result.values()].map(m => ({ id: m.config_name, name: m.display_name || m.config_name })));
  };
  return { models, auth: {
    refresh, refreshLead: 300000,
    methods: [{ type: 'oauth', label: 'Trae 浏览器授权', authorize: async () => {
      const path = '/authorize/' + randomBytes(24).toString('hex');
      const device = { deviceId: randomUUID(), machineId: randomUUID() };
      let resolve!: (a: SubscriptionAuth) => void; let reject!: (e: Error) => void;
      const done = new Promise<SubscriptionAuth>((yes, no) => { resolve = yes; reject = no; }); void done.catch(() => {});
      let claimed = false;
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname !== path || claimed || req.headers.origin && req.headers.origin !== web) { res.writeHead(404).end(); return; }
        res.setHeader('Access-Control-Allow-Origin', web); res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        claimed = true;
        try {
          const info = JSON.parse(url.searchParams.get('userInfo') || '{}'); const jwt = JSON.parse(url.searchParams.get('userJwt') || '{}');
          const a = credentials(jwt, { ...device, uid: String(info.UserID || info.userId || ''), accountName: info.ScreenName || info.screenName, region: /coreva|us-east/.test(String(info.Host || url.searchParams.get('host') || '')) ? 'us' : 'sg' });
          token(a.uid); resolve(a); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('AI Usage 授权成功，可以关闭此页面。');
        } catch { reject(new Error('SUBSCRIPTION_LOGIN_FAILED')); res.writeHead(400).end('Authorization failed'); }
        finally { server.close(); }
      });
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
      const timer = setTimeout(() => { server.close(); reject(new Error('SUBSCRIPTION_LOGIN_TIMEOUT')); }, 600000);
      void done.then(() => clearTimeout(timer), () => clearTimeout(timer));
      const port = (server.address() as { port: number }).port;
      const q = new URLSearchParams({ login_version: '1', auth_from: 'solo', login_channel: 'native_ide', plugin_version: global ? '2.3.62834' : '2.3.24254', auth_type: 'local', client_id: 'ono9krqynydwx5', redirect: '0', login_trace_id: randomUUID(), auth_callback_url: `http://127.0.0.1:${port}${path}`, machine_id: device.machineId, device_id: device.deviceId, x_app_version: global ? '3.5.51' : '3.3.65', x_app_type: 'stable', hide_saas_login: 'false' });
      return { url: web + '/authorization?' + q, method: 'auto', callback: () => done };
    } }],
    transport: async getAuth => ({ fetch: async (_url, init) => {
        const controller = new AbortController();
        init = { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal };
      const a = await getAuth(); const request = JSON.parse(String(init?.body || '{}'));
      if (!catalog.has(request.model)) await models(a); const m = catalog.get(request.model);
      if (!m) return Response.json({ error: { message: 'SUBSCRIPTION_MODEL_UNAVAILABLE' } }, { status: 404 });
      const body = { ...request, messages: (request.messages || []).map((msg: Json) => ({ ...msg, content: typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content })),
        function: m.fn, config_name: m.config_name, stream: true, request_id: randomUUID(), session_id: new Headers(init?.headers).get('x-jusage-session') || randomUUID(),
        model_name: m.model_detail_list?.find((d: Json) => /__dev$/.test(d.model_name))?.model_name };
      const response = await quotaResponse(await fetcher(api(a) + '/api/agent/v3/llm_utils_chat', { ...init, redirect: 'error', body: JSON.stringify(body), headers: headers(a) }));
      if (!response.ok || !response.body) return response;
      return eventResponse((async function* () {
        const id = 'chatcmpl-' + randomUUID(); let finished = false; let tools = false; let count = 0;
        const decoder = new TextToolDecoder(request.tools || []);
        const chunk = (delta: Json, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, delta, finish_reason }] });
        const pieces = (content: string, end = false) => decoder.feed(content, end).map(part => {
          if (!part.name) return chunk({ content: part.text });
          tools = true; return chunk({ tool_calls: [{ index: count++, id: 'call_' + randomUUID(), type: 'function', function: { name: part.name, arguments: part.arguments } }] });
        });
        for await (const { event, data } of sseEvents(response.body!)) {
          if (data === '[DONE]') { finished = true; break; }
          const d = JSON.parse(data); const name = event.toLowerCase().replace(/-/g, '_');
          if (name === 'error' || d.code && d.message && !d.response) throw new ChannelError(/quota|credit|limit|余额|额度/i.test(d.message) ? 429 : /token|expired|登录/i.test(d.message) ? 401 : 502);
          if (['done', 'response_done', 'stream_done'].includes(name)) { finished = true; if (d.usage) yield { ...chunk({}), usage: d.usage }; break; }
          if (d.choices) { yield d; if (d.choices.some((c: Json) => c.finish_reason)) finished = true; continue; }
          if (name === 'token_usage') { yield { ...chunk({}), usage: d.usage || d }; continue; }
          const delta: Json = {};
          const content = d.response || d.content || d.delta?.content || (typeof d.delta === 'string' ? d.delta : '');
          if (typeof content === 'string' && content && !/^(Building prompt:|Completed building prompt)/.test(content)) yield* pieces(content);
          const thought = d.reasoning_content || d.reasoning || d.delta?.reasoning_content; if (thought) delta.reasoning_content = thought;
          if (d.tool_calls) { delta.tool_calls = d.tool_calls; tools = true; }
          if (Object.keys(delta).length) yield chunk(delta);
          if (d.finish_reason || d.stop_reason) finished = true;
        }
        if (!finished) throw new ChannelError(502, 'SUBSCRIPTION_TRUNCATED_STREAM');
        yield* pieces('', true);
        yield chunk({}, tools ? 'tool_calls' : 'stop'); yield '[DONE]';
      })(), () => controller.abort());
    } }),
  } };
}

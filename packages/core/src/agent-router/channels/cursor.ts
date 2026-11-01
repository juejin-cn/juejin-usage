import { connect } from 'node:http2';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, type Json, expires, json, jwt, modelRows, poll, post, readJson, record, token } from './http.js';
import { eventResponse } from './streams.js';
import { binary, connectFrame, connectFrames, decodeValue, encodeValue, field as f, message as msg, number as num, parseProto as parse, string as str } from './protobuf.js';
const api = 'https://api2.cursor.sh';
const client = { 'x-cursor-client-version': '2026.09.23-86fc751', 'x-cursor-client-type': 'cli', 'x-ghost-mode': 'true', 'connect-protocol-version': '1' };
const namespace = 'jusage';
const toolDefinition = (tool: Json) => msg(f(1, tool.name), f(2, tool.description || ''), f(3, encodeValue(tool.parameters || { type: 'object', properties: {} })), f(4, namespace), f(5, tool.name), f(6, JSON.stringify(tool.parameters || { type: 'object', properties: {} })));
const environment = () => msg(f(1, process.platform), f(2, '/'), f(10, 'UTC'));
const text = (content: any): string => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
export function cursorRequest(chat: Json, session: string): { first: Buffer; blobs: Map<string, Buffer>; tools: Json[] } {
  if (chat.tool_choice && !['auto', 'none'].includes(chat.tool_choice)) throw new ChannelError(400, 'SUBSCRIPTION_TOOL_CHOICE_UNSUPPORTED');
  const tools = chat.tool_choice === 'none' ? [] : (chat.tools || []).filter((t: Json) => t.type === 'function').map((t: Json) => t.function);
  const history: Json[] = [];
  const system = (chat.messages || []).filter((m: Json) => ['system', 'developer'].includes(m.role)).map((m: Json) => text(m.content)).join('\n\n');
  const instructions = tools.length ? '\nAvailable client tools (use CallDynamicTool with namespace "jusage", toolName, and arguments matching the schema):\n' + JSON.stringify(tools) : '';
  if (system || instructions) history.push({ role: 'system', content: system + instructions });
  let last = '.';
  for (const m of chat.messages || []) {
    if (['system', 'developer'].includes(m.role)) continue;
    if (m.role === 'tool') history.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: m.tool_call_id.replace('__fc_', '\nfc_'), toolName: 'CallDynamicTool', result: text(m.content), experimental_content: [{ type: 'text', text: text(m.content) }] }] });
    else {
      const content: Json[] = [];
      if (text(m.content)) content.push({ type: 'text', text: text(m.content) });
      for (const p of Array.isArray(m.content) ? m.content : []) if (p.type === 'image_url') {
        const image = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url || '');
        if (!image) throw new Error('SUBSCRIPTION_IMAGE_UNSUPPORTED');
        content.push({ type: 'image', mimeType: image[1], image: { __type: 'Uint8Array', hex: Buffer.from(image[2], 'base64').toString('hex') } });
      }
      for (const call of m.tool_calls || []) content.push({ type: 'tool-call', toolCallId: call.id.replace('__fc_', '\nfc_'), toolName: 'CallDynamicTool', args: { namespace, toolName: call.function.name, arguments: JSON.parse(call.function.arguments || '{}') } });
      if (m.role === 'user') last = text(m.content) || '.';
      history.push({ role: m.role, content });
    }
  }
  const blobs = new Map<string, Buffer>();
  const put = (value: Buffer) => { const hash = createHash('sha256').update(value).digest(); blobs.set(hash.toString('hex'), value); return hash; };
  const userId = randomUUID(); const user = msg(f(1, last), f(2, userId), f(4, 1)); const turn = f(1, msg(f(1, put(user)), f(10, userId)));
  const state = msg(...history.map(m => f(1, put(Buffer.from(JSON.stringify(m))))), f(8, put(turn)), f(10, 1), f(22, 'cli'));
  const context = msg(f(4, environment()), ...tools.map((t: Json) => f(7, toolDefinition(t))));
  const run = msg(f(1, state), f(2, f(2, f(2, context))), f(3, msg(f(1, chat.model), f(3, chat.model), f(4, chat.model))),
    f(4, msg(...tools.map((t: Json) => f(1, toolDefinition(t))))), f(5, session || randomUUID()), f(9, f(1, chat.model)), f(19, 1));
  return { first: f(1, run), blobs, tools };
}
export function cursorChannel(fetcher: typeof fetch = fetch, connectTransport: typeof connect = connect): SubscriptionChannel {
  const access = (a: SubscriptionAuth) => { if (Number(a.expires) > 0 && Number(a.expires) <= Date.now()) throw new ChannelError(401); return token(a.access); };
  const rpc = (a: SubscriptionAuth, route: string, body: Json = {}) => json(fetcher, api + '/' + route, post(body, { ...client, authorization: `Bearer ${access(a)}` }));
  return {
    models: async a => { const data = await rpc(a, 'agent.v1.AgentService/GetUsableModels'); return modelRows(data.models?.map((m: Json) => ({ id: m.modelId, name: m.displayName || m.displayModelId || m.modelId }))); },
    auth: {
      account: async getAuth => {
        const a = await getAuth();
        const [me, plan] = await Promise.allSettled([rpc(a, 'aiserver.v1.DashboardService/GetMe'), rpc(a, 'aiserver.v1.DashboardService/GetPlanInfo')]);
        if (me.status === 'rejected' && plan.status === 'rejected') throw new Error('SUBSCRIPTION_ACCOUNT_UNAVAILABLE');
        return { ...(me.status === 'fulfilled' ? { accountName: me.value.name || me.value.email, email: me.value.email } : {}), ...(plan.status === 'fulfilled' ? { plan: plan.value.planInfo?.planName } : {}) };
      },
      methods: [{ type: 'oauth', label: 'Cursor 浏览器授权', authorize: async () => {
        const verifier = randomBytes(32).toString('base64url'); const id = randomUUID();
        const q = new URLSearchParams({ uuid: id, challenge: createHash('sha256').update(verifier).digest('base64url'), mode: 'login', redirectTarget: 'cli' });
        return { url: 'https://cursor.com/loginDeepControl?' + q, method: 'auto', callback: async () => {
          const d = await poll(async () => {
            const r = await fetcher(api + '/auth/poll?' + new URLSearchParams({ uuid: id, verifier }), { headers: client, redirect: 'error', signal: AbortSignal.timeout(15000) });
            if (r.status === 404) { await r.body?.cancel(); return undefined; }
            if (!r.ok) { await r.body?.cancel(); throw new ChannelError(r.status); } return record(await readJson(r));
          });
          return { type: 'oauth', access: token(d.accessToken), refresh: d.refreshToken || '', expires: expires(jwt(d.accessToken).exp, 0), uid: jwt(d.accessToken).sub };
        } };
      } }],
      transport: async getAuth => ({ fetch: async (_url, init) => {
        const a = await getAuth(); const chat = JSON.parse(String(init?.body || '{}'));
        const built = cursorRequest(chat, new Headers(init?.headers).get('x-jusage-session') || randomUUID());
        const config = await rpc(a, 'aiserver.v1.ServerConfigService/GetServerConfig');
        const destination = new URL(config.agentUrlConfig?.agentUrl || config.agentUrlConfig?.agentnUrl || 'https://agentn.global.api5.cursor.sh');
        if (destination.protocol !== 'https:' || !destination.hostname.endsWith('.cursor.sh') || destination.username || destination.password) throw new ChannelError(502);
        const connection = connectTransport(destination.origin); connection.on('error', () => {});
        const request = connection.request({ ':method': 'POST', ':path': destination.pathname.replace(/\/$/, '') + '/agent.v1.AgentService/Run', ...client, authorization: `Bearer ${access(a)}`, 'content-type': 'application/connect+proto', 'connect-accept-encoding': 'gzip' });
        request.on('error', () => {});
        const close = () => { request.destroy(); connection.destroy(); };
        const abort = () => close(); init?.signal?.addEventListener('abort', abort, { once: true }); if (init?.signal?.aborted) close();
        request.setTimeout(120000, () => request.destroy(new ChannelError(504)));
        request.once('close', () => { init?.signal?.removeEventListener('abort', abort); connection.destroy(); });
        const send = async (data: Buffer) => { if (!request.write(connectFrame(data))) await once(request, 'drain'); };
        try {
          const head = once(request, 'response'); await send(built.first); const [headers] = await head;
          if (Number(headers[':status']) !== 200) { close(); return Response.json({ error: { message: 'SUBSCRIPTION_UPSTREAM_FAILED' } }, { status: Number(headers[':status']) || 502 }); }
          return await eventResponse((async function* () {
            let count = 0; let expected: number | undefined; let ended = false; let saw = false; let usage: Json | undefined;
            const id = 'chatcmpl-' + randomUUID();
            const chunk = (delta: Json, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', model: chat.model, created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta, finish_reason }] });
            try {
              outer: for await (const frame of connectFrames(request)) {
                if (frame.end) { const error = JSON.parse(frame.data.toString() || '{}').error; if (error) throw new ChannelError(error.code === 'resource_exhausted' ? 429 : error.code === 'unauthenticated' ? 401 : 502); ended = true; break; }
                for (const [kind, values] of parse(frame.data)) for (const value of values) {
                  if (!Buffer.isBuffer(value)) continue; const p = parse(value);
                  if (kind === 1) for (const [update, items] of p) for (const item of items) {
                    if (!Buffer.isBuffer(item)) continue; const detail = parse(item);
                    if (update === 1 || update === 4) { const content = str(detail, 1); if (content) { saw = true; yield chunk({ [update === 1 ? 'content' : 'reasoning_content']: content }); } }
                    if (update === 14) { usage = { prompt_tokens: num(detail, 1), completion_tokens: num(detail, 2), prompt_tokens_details: { cached_tokens: num(detail, 3) } }; ended = true; break outer; }
                    if (update === 27) expected = num(detail, 1);
                  }
                  if (kind === 4) {
                    const requestId = num(p, 1);
                    if (p.has(2)) { const hash = binary(parse(binary(p, 2)), 1).toString('hex'); const blob = built.blobs.get(hash); await send(f(3, msg(f(1, requestId), f(2, blob ? f(1, blob) : f(2, f(1, 'Unknown history blob')))))); }
                    if (p.has(3)) await send(f(3, msg(f(1, requestId), f(3, Buffer.alloc(0)))));
                  }
                  if (kind === 2) {
                    const requestId = num(p, 1); const execId = str(p, 15);
                    const reply = async (kind: number, data: Buffer) => { await send(f(2, msg(f(1, requestId), f(15, execId), f(kind, data)))); await send(f(5, f(1, f(1, requestId)))); };
                    if (p.has(11)) {
                      const call = parse(binary(p, 11)); const name = str(call, 5) || str(call, 1).replace(/^jusage-/, '');
                      if (!built.tools.some((t: Json) => t.name === name) || str(call, 4) && str(call, 4) !== namespace || num(call, 7) || call.has(6)) throw new ChannelError(502, 'SUBSCRIPTION_TOOL_UNAVAILABLE');
                      const args = Object.create(null);
                      for (const entry of call.get(2) || []) { const pair = parse(entry as Buffer); args[str(pair, 1)] = decodeValue(binary(pair, 2)); }
                      saw = true; yield chunk({ tool_calls: [{ index: count++, id: (str(call, 3) || 'call_' + randomUUID()).replaceAll('\n', '__'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
                    } else if (p.has(36)) await reply(36, f(1, f(1, msg(f(1, namespace), f(2, namespace), f(7, 'connected'), ...built.tools.map((t: Json) => f(5, toolDefinition(t)))))));
                    else if (p.has(10)) await reply(10, f(1, f(1, f(4, environment()))));
                    else { await send(f(5, f(2, msg(f(1, requestId), f(2, 'Tool must be provided by the client'))))); await send(f(5, f(1, f(1, requestId)))); }
                  }
                  if (count > 0 && expected !== undefined && count >= expected) { ended = true; break outer; }
                }
              }
              if (!ended || !saw) throw new ChannelError(502, 'SUBSCRIPTION_TRUNCATED_STREAM');
              yield { ...chunk({}, count ? 'tool_calls' : 'stop'), ...(usage ? { usage } : {}) }; yield '[DONE]';
            } finally { close(); }
          })(), close);
        } catch (error) { close(); throw error; }
      } }),
    },
  };
}

import { antigravityMetadata } from './model-metadata.js';
import { randomUUID } from 'node:crypto';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';
import { ChannelError, json, modelRows, oauth, post, record, token, type Json } from './http.js';
import { eventResponse, sse } from './streams.js';

const root = 'https://daily-cloudcode-pa.googleapis.com';
import { antigravityLogin, antigravityProject, ANTIGRAVITY_CLIENT_ID as clientId, ANTIGRAVITY_CLIENT_SECRET as clientSecret } from '../native/antigravity-oauth.js';
const headers = (a: SubscriptionAuth) => ({ authorization: `Bearer ${token(a.access)}`, 'content-type': 'application/json', 'user-agent': 'antigravity' });

export function antigravityRequest(body: Json): Json {
  const calls = new Map<string, string>();
  const contents: Json[] = []; const system: Json[] = [];
  for (const message of body.messages ?? []) {
    if (message.role === 'tool') {
      let response: unknown; try { response = JSON.parse(message.content); } catch { response = { result: message.content }; }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: calls.get(message.tool_call_id) ?? message.name ?? 'tool', response: typeof response === 'object' && response !== null ? response : { result: response } } }] });
      continue;
    }
    const parts: Json[] = [];
    for (const item of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
      if (item.type === 'text') parts.push({ text: item.text });
      else if (item.type === 'image_url') {
        const match = /^data:([^;,]+);base64,(.+)$/.exec(item.image_url?.url ?? '');
        if (!match) throw new ChannelError(400, 'SUBSCRIPTION_UNSUPPORTED_IMAGE');
        parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      } else throw new ChannelError(400, 'SUBSCRIPTION_UNSUPPORTED_CONTENT');
    }
    for (const call of message.tool_calls ?? []) {
      calls.set(call.id, call.function.name);
      const signature = call.extra_content?.google?.thought_signature;
      parts.push({ functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments || '{}') }, ...(signature ? { thoughtSignature: signature } : {}) });
    }
    if (message.role === 'system' || message.role === 'developer') system.push(...parts);
    else if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  const generationConfig: Json = {};
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) generationConfig.maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  if (body.stop) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.response_format?.type === 'json_object') generationConfig.responseMimeType = 'application/json';
  if (body.response_format?.type === 'json_schema') { generationConfig.responseMimeType = 'application/json'; generationConfig.responseJsonSchema = body.response_format.json_schema?.schema; }
  const declarations = (body.tools ?? []).map((t: Json) => ({ name: t.function.name, description: t.function.description, parametersJsonSchema: t.function.parameters ?? { type: 'object', properties: {} } }));
  const choice = body.tool_choice;
  const toolConfig = choice ? { functionCallingConfig: { mode: choice === 'none' ? 'NONE' : choice === 'required' || typeof choice === 'object' ? 'ANY' : 'AUTO', ...(typeof choice === 'object' ? { allowedFunctionNames: [choice.function.name] } : {}) } } : undefined;
  return { contents, generationConfig, ...(system.length ? { systemInstruction: { parts: system } } : {}), ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}), ...(toolConfig ? { toolConfig } : {}) };
}

function reply(value: Json, model: string, id: string, streaming: boolean, toolIndex = 0): Json {
  const native = value.response ?? value;
  if (native.error) throw new ChannelError(Number(native.error.code) || 502);
  const candidate = native.candidates?.[0];
  const parts: Json[] = candidate?.content?.parts ?? [];
  const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
  const reasoning = parts.filter(p => p.thought && typeof p.text === 'string').map(p => p.text).join('');
  const tools = parts.filter(p => p.functionCall).map((p, index) => ({ ...(streaming ? { index: toolIndex + index } : {}), id: 'call_' + randomUUID(), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) }, ...(p.thoughtSignature ? { extra_content: { google: { thought_signature: p.thoughtSignature } } } : {}) }));
  const content = { ...(streaming ? {} : { role: 'assistant', content: text || null }), ...(streaming && text ? { content: text } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.length ? { tool_calls: tools } : {}) };
  const finish = candidate?.finishReason ? candidate.finishReason === 'MAX_TOKENS' ? 'length' : candidate.finishReason === 'STOP' ? tools.length ? 'tool_calls' : 'stop' : 'content_filter' : streaming ? null : 'stop';
  const usage = native.usageMetadata;
  return { id, object: streaming ? 'chat.completion.chunk' : 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, ...(streaming ? { delta: content } : { message: content }), finish_reason: finish }], ...(usage ? { usage: { prompt_tokens: usage.promptTokenCount ?? 0, completion_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), total_tokens: usage.totalTokenCount ?? 0 } } : {}) };
}

export function antigravityChannel(fetcher: typeof fetch = fetch): SubscriptionChannel {
  return {
    models: async auth => {
      const catalog = await json(fetcher, root + '/v1internal:fetchAvailableModels', post({ project: token(auth.project) }, headers(auth)));
      return modelRows(Object.entries(record(catalog.models)).map(([id, value]) => ({ ...value, id, display_name: value?.displayName })), 'id', antigravityMetadata);
    },
    auth: {
      refresh: async auth => {
        if (!auth.refresh) throw new ChannelError(401);
        return oauth(await json(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token(auth.refresh), client_id: clientId, client_secret: clientSecret }) }), auth);
      },
      methods: [{ type: 'oauth', label: '使用 Google 账号登录', authorize: () => antigravityLogin(fetcher) },
        { type: 'oauth', label: '导入 Antigravity OAuth 凭据', prompts: [{ key: 'credentials', type: 'password', message: 'OAuth 凭据 JSON（access_token / refresh_token / project_id）' }], authorize: async (input = {}) => {
        let saved: Json;
        try { saved = record(JSON.parse(input.credentials ?? '')); } catch { throw new Error('SUBSCRIPTION_INPUT_INVALID'); }
        if (saved.type && saved.type !== 'antigravity') throw new Error('SUBSCRIPTION_INPUT_INVALID');
        const access = token(saved.access_token);
        let project = saved.project_id;
        if (!project) project = await antigravityProject(access, fetcher);
        return { type: 'oauth', access, ...(saved.refresh_token ? { refresh: token(saved.refresh_token) } : {}), expires: saved.expired ? Date.parse(saved.expired) : saved.expiry_date ?? Date.now() + 3600_000, project: token(project), accountName: saved.email, uid: saved.email };
      } }],
      transport: async getAuth => ({ fetch: async (_url, init) => {
        const auth = await getAuth(); const body = record(JSON.parse(String(init?.body)));
        const stream = Boolean(body.stream); const id = 'chatcmpl-' + randomUUID();
        const response = await fetcher(root + (stream ? '/v1internal:streamGenerateContent?alt=sse' : '/v1internal:generateContent'), {
          ...init, redirect: 'error', headers: headers(auth), body: JSON.stringify({ project: token(auth.project), model: body.model, requestId: randomUUID(), userAgent: 'antigravity', requestType: 'agent', request: antigravityRequest(body) }),
        });
        if (!response.ok) { await response.body?.cancel(); return Response.json({ error: { message: response.status === 401 ? 'SUBSCRIPTION_LOGIN_REQUIRED' : 'SUBSCRIPTION_UPSTREAM_FAILED' } }, { status: response.status }); }
        if (!stream) return Response.json(reply(record(await response.json()), body.model, id, false));
        if (!response.body) throw new ChannelError(502);
        return eventResponse((async function* () {
          let index = 0; let hasTools = false;
          for await (const data of sse(response.body!)) {
            if (data === '[DONE]') break;
            const chunk = reply(record(JSON.parse(data)), body.model, id, true, index);
            const calls = chunk.choices[0].delta.tool_calls?.length ?? 0; index += calls; hasTools ||= calls > 0;
            if (hasTools && chunk.choices[0].finish_reason === 'stop') chunk.choices[0].finish_reason = 'tool_calls';
            yield chunk;
          }
          yield '[DONE]';
        })());
      } }),
    },
  };
}

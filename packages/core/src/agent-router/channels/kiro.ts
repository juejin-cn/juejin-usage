import { kiroMetadata } from './model-metadata.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';
import { convertRequest } from '../protocol/index.js';
import { ChannelError, type Json, json, jwt, modelRows, token } from './http.js';
import { accountHash, readLocalJson } from './local-auth.js';
import { eventResponse } from './streams.js';

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export async function* awsEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ type: string; value: Json }> {
  const reader = body.getReader(); let buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { if (buffer.length) throw new ChannelError(502, 'SUBSCRIPTION_TRUNCATED_STREAM'); break; }
      buffer = Buffer.concat([buffer, part.value]);
      while (buffer.length >= 12) {
        const size = buffer.readUInt32BE(0); const headerSize = buffer.readUInt32BE(4);
        if (size < 16 || size > 8 * 1024 * 1024 || headerSize > size - 16 || crc32(buffer.subarray(0, 8)) !== buffer.readUInt32BE(8)) throw new ChannelError(502);
        if (buffer.length < size) break;
        const frame = buffer.subarray(0, size); buffer = buffer.subarray(size);
        if (crc32(frame.subarray(0, -4)) !== frame.readUInt32BE(size - 4)) throw new ChannelError(502);
        const headers: Record<string, string> = {}; let offset = 12;
        while (offset < 12 + headerSize) {
          const length = frame[offset++]; const name = frame.toString('utf8', offset, offset + length); offset += length;
          const kind = frame[offset++];
          if (kind === 6 || kind === 7) { const n = frame.readUInt16BE(offset); offset += 2; if (kind === 7) headers[name] = frame.toString('utf8', offset, offset + n); offset += n; }
          else { const n = [0, 0, 1, 2, 4, 8, -1, -1, 8, 16][kind]; if (n === undefined || n < 0) throw new ChannelError(502); offset += n; }
          if (offset > 12 + headerSize) throw new ChannelError(502);
        }
        if (['exception', 'error'].includes(headers[':message-type'])) throw new ChannelError(/throttl/i.test(headers[':exception-type'] || '') ? 429 : 502);
        yield { type: headers[':event-type'], value: JSON.parse(frame.toString('utf8', 12 + headerSize, size - 4)) };
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const text = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') : '';
const safeName = (name: string) => /^[\w-]{1,64}$/.test(name) ? name : name.replace(/[^\w-]/g, '_').slice(0, 45) + '_' + createHash('sha256').update(name).digest('hex').slice(0, 16);
export function kiroRequest(chat: Json, profile: string): { body: Json; names: Map<string, string> } {
  if (chat.tool_choice && !['auto', 'none'].includes(chat.tool_choice)) throw new ChannelError(400, 'SUBSCRIPTION_TOOL_CHOICE_UNSUPPORTED');
  const req = convertRequest(chat, 'chat', 'messages'); const names = new Map<string, string>();
  if (chat.tool_choice === 'none') req.tools = [];
  for (const t of req.tools || []) names.set(safeName(t.name), t.name);
  const entries: Json[] = [];
  for (const m of req.messages || []) {
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') entries.push({ assistantResponseMessage: { content: text(parts), ...(parts.some((p: Json) => p.type === 'tool_use') ? { toolUses: parts.filter((p: Json) => p.type === 'tool_use').map((p: Json) => ({ name: safeName(p.name), toolUseId: p.id, input: p.input })) } : {}) } });
    else {
      const results = parts.filter((p: Json) => p.type === 'tool_result').map((p: Json) => ({ toolUseId: p.tool_use_id, status: p.is_error ? 'error' : 'success', content: [{ text: text(p.content) || '(empty)' }] }));
      const images = parts.filter((p: Json) => p.type === 'image').map((p: Json) => { if (p.source?.type !== 'base64') throw new Error('SUBSCRIPTION_IMAGE_UNSUPPORTED'); return { format: String(p.source.media_type).replace('image/', '').replace('jpg', 'jpeg'), source: { bytes: p.source.data } }; });
      const message = { content: text(parts), modelId: chat.model, origin: 'KIRO_CLI', ...(results.length ? { userInputMessageContext: { toolResults: results } } : {}), ...(images.length ? { images } : {}) };
      const previous = entries.at(-1)?.userInputMessage;
      if (previous) {
        previous.content += '\n' + message.content;
        if (results.length) { previous.userInputMessageContext ??= {}; previous.userInputMessageContext.toolResults = [...(previous.userInputMessageContext.toolResults || []), ...results]; }
        if (images.length) previous.images = [...(previous.images || []), ...images];
      } else entries.push({ userInputMessage: message });
    }
  }
  if (!entries[0]?.userInputMessage) entries.unshift({ userInputMessage: { content: '', modelId: chat.model, origin: 'KIRO_CLI' } });
  entries[0].userInputMessage.content = [text(req.system), entries[0].userInputMessage.content].filter(Boolean).join('\n\n');
  if (!entries.at(-1)?.userInputMessage) entries.push({ userInputMessage: { content: 'Continue.', modelId: chat.model, origin: 'KIRO_CLI' } });
  const current = entries.at(-1)!.userInputMessage;
  if (req.tools?.length) { current.userInputMessageContext ??= {}; current.userInputMessageContext.tools = req.tools.map((t: Json) => ({ toolSpecification: { name: safeName(t.name), description: t.description || t.name, inputSchema: { json: t.input_schema } } })); }
  return { names, body: { profileArn: profile, agentMode: 'vibe', conversationState: { chatTriggerType: 'MANUAL', agentTaskType: 'vibe', conversationId: randomUUID(), currentMessage: { userInputMessage: current }, ...(entries.length > 1 ? { history: entries.slice(0, -1) } : {}) } } };
}
export function kiroChannel(fetcher: typeof fetch = fetch, path = () => join(homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json')): SubscriptionChannel {
  const current = async (a?: SubscriptionAuth) => {
    const d = await readLocalJson(path()); const access = token(d.accessToken);
    const identity = token(d.profileArn || jwt(access).sub); const uid = accountHash(identity);
    if (a && a.uid !== uid || d.expiresAt && Date.parse(d.expiresAt) <= Date.now()) throw new ChannelError(401);
    const region = String(d.profileArn || '').split(':')[3] || d.region || 'us-east-1';
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new ChannelError(401);
    return { access, uid, region, profile: d.profileArn || '' };
  };
  return {
    models: async a => { const c = await current(a); return modelRows((await json(fetcher, `https://management.${c.region}.kiro.dev/List-Available-Models?` + new URLSearchParams({ origin: 'KIRO_CLI', profileArn: c.profile }), { headers: { authorization: `Bearer ${c.access}` } })).models?.map((m: Json) => ({ ...m, id: m.modelId, name: m.modelName })), 'id', kiroMetadata); },
    auth: {
      methods: [{ type: 'oauth', label: '读取 Kiro IDE 本机登录', authorize: async () => ({ type: 'oauth', source: 'kiro-local', uid: (await current()).uid }) }],
      transport: async getAuth => ({ fetch: async (_url, init) => {
        const controller = new AbortController();
        init = { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal };
        const c = await current(await getAuth()); const chat = JSON.parse(String(init?.body || '{}')); const request = kiroRequest(chat, c.profile);
        const response = await fetcher(`https://runtime.${c.region}.kiro.dev/generateAssistantResponse`, { ...init, method: 'POST', redirect: 'error', body: JSON.stringify(request.body), headers: {
          authorization: `Bearer ${c.access}`, 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream', 'x-amzn-codewhisperer-optout': 'true', 'x-amzn-kiro-agent-mode': 'vibe', 'amz-sdk-invocation-id': randomUUID(), 'amz-sdk-request': 'attempt=1; max=1',
          'user-agent': 'aws-sdk-rust/1.0.0 app/AmazonQ-For-CLI',
        } });
        if (!response.ok || !response.body) return response;
        return eventResponse((async function* () {
          const id = 'chatcmpl-' + randomUUID(); const calls = new Map<string, number>(); let active = ''; let usage: Json | undefined; let saw = false;
          const chunk = (delta: Json, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: chat.model, choices: [{ index: 0, delta, finish_reason }] });
          for await (const { type, value } of awsEvents(response.body!)) {
            if (type === 'assistantResponseEvent' && value.content) { saw = true; yield chunk({ content: value.content }); }
            if (type === 'reasoningContentEvent' && value.text) { saw = true; yield chunk({ reasoning_content: value.text }); }
            if (type === 'toolUseEvent') {
              if (value.toolUseId) active = value.toolUseId;
              if (!active) throw new ChannelError(502);
              if (!calls.has(active)) { if (!value.name) throw new ChannelError(502); calls.set(active, calls.size); saw = true; yield chunk({ tool_calls: [{ index: calls.get(active), id: active, type: 'function', function: { name: request.names.get(value.name) || value.name, arguments: '' } }] }); }
              if (value.input) yield chunk({ tool_calls: [{ index: calls.get(active), function: { arguments: typeof value.input === 'string' ? value.input : JSON.stringify(value.input) } }] });
            }
            if (/error|exception/i.test(type)) throw new ChannelError(/throttl/i.test(type) ? 429 : 502);
            if (value.tokenUsage) usage = { prompt_tokens: value.tokenUsage.inputTokens || value.tokenUsage.uncachedInputTokens || 0, completion_tokens: value.tokenUsage.outputTokens || 0 };
          }
          if (!saw) throw new ChannelError(502, 'SUBSCRIPTION_EMPTY_RESPONSE');
          yield { ...chunk({}, calls.size ? 'tool_calls' : 'stop'), ...(usage ? { usage } : {}) }; yield '[DONE]';
        })(), () => controller.abort());
      } }),
    },
  };
}

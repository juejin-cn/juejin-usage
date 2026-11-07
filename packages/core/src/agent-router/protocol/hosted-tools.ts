import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { RouterError, type Protocol } from '../config.js';
import type { TransportReply } from '../transport.js';
import { convertReply, convertRequest } from './index.js';
import { streamNativeResponse } from './native-responses.js';
import type { Wire } from './request.js';
import { EventEncoder } from './encode.js';
import { jsonEvents } from './events.js';

export interface SearchHit { title: string; url: string; snippet?: string }
export interface WebSearchResult { text: string; sources: SearchHit[]; error?: string }
export type WebSearchExecutor = (query: string, options: Wire, signal: AbortSignal) => Promise<WebSearchResult>;
interface SearchRecord extends WebSearchResult { id: string; query: string }
export interface HostedToolPlan { body: Wire; source: Protocol; name: string; options: Wire; clientTools: unknown; clientInput: unknown }
const list = (v: unknown): Wire[] => Array.isArray(v) ? v : [];
const searchType = (v: unknown) => typeof v === 'string' && /^(?:web_search(?:_preview)?(?:_\d+)?|web_search_\d+)$/.test(v);
const jsonReply = (value: Wire): TransportReply => {
  const body = Readable.from([JSON.stringify(value)]);
  return { status: 200, headers: { 'content-type': 'application/json' }, body, dispose() { body.destroy(); } };
};
export async function replyJson(reply: TransportReply, signal: AbortSignal): Promise<Wire> {
  let raw = ''; let size = 0;
  try {
    for await (const chunk of reply.body) {
      signal.throwIfAborted(); size += Buffer.byteLength(chunk);
      if (size > 16 * 1024 * 1024) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
      raw += chunk;
    }
    signal.throwIfAborted();
    return JSON.parse(raw);
  } finally { reply.dispose(); }
}
function searchHistory(item: Wire): Wire {
  return { type: 'message', role: 'assistant', content: `Previous web search: ${JSON.stringify(item)}` };
}
/** Provider-independent server-tool lowering. Same-protocol requests stay native.
 * Unknown hosted capabilities remain explicit errors rather than fake functions. */
export function hostedToolPlan(body: Wire, source: Protocol, target: Protocol): HostedToolPlan | undefined {
  if (source === target) return;
  let portable = { ...body }; let options: Wire | undefined;
  let offered = false;
  if (source === 'responses') {
    const searches = list(body.tools).filter(t => searchType(t.type));
    if (searches.length > 1) throw new RouterError('AMBIGUOUS_TOOL_NAME');
    options = searches[0];
    offered = Boolean(options);
    if (options || list(body.input).some(i => i.type === 'web_search_call')) {
      options ??= { max_uses: 0 };
      portable.tools = list(body.tools).filter(t => !searchType(t.type));
      if (Array.isArray(body.input)) portable.input = body.input.map((item: Wire) => item.type === 'web_search_call' ? searchHistory(item) : item);
    }
  } else if (source === 'messages') {
    options = list(body.tools).find(t => searchType(t.type));
    offered = Boolean(options);
    if (options || list(body.messages).some(m => list(m.content).some(p => p.type === 'web_search_tool_result' || p.type === 'server_tool_use' && p.name === 'web_search'))) {
      options ??= { max_uses: 0 };
      portable.tools = list(body.tools).filter(t => !searchType(t.type));
      portable.messages = list(body.messages).map(m => ({ ...m, content: typeof m.content === 'string' ? m.content : list(m.content).map(p =>
        p.type === 'server_tool_use' && p.name === 'web_search' || p.type === 'web_search_tool_result'
          ? { type: 'text', text: `Previous web search: ${JSON.stringify(p)}` } : p) }));
    }
  } else if (source === 'chat') {
    options = body.web_search_options;
    offered = Boolean(options);
    delete portable.web_search_options;
  } else if (source === 'gemini') {
    const tool = list(body.tools).find(t => t.googleSearch || t.google_search);
    options = tool?.googleSearch ?? tool?.google_search;
    offered = Boolean(options);
    if (options) portable.tools = list(body.tools).flatMap(t => {
      const { googleSearch, google_search, ...rest } = t;
      return Object.keys(rest).length ? [rest] : [];
    });
  }
  if (!options) return;
  const clientTools = portable.tools; const clientInput = portable.input;
  // A random private name cannot collide with a client tool or be mistaken
  // for a client-owned search; only this exact name executes on the gateway.
  const name = 'gateway_web_search_' + randomUUID().replaceAll('-', '');
  const selected = source === 'responses' && searchType(body.tool_choice?.type)
    || source === 'messages' && body.tool_choice?.type === 'tool' && body.tool_choice.name === 'web_search';
  if (selected) delete portable.tool_choice;
  const chat = convertRequest(portable, source, 'chat');
  if (offered) chat.tools = [...list(chat.tools), { type: 'function', function: { name, description: 'Search the web for current information. Returns real source URLs and excerpts. Cite the returned sources; never invent results.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A focused web search query' } }, required: ['query'], additionalProperties: false } } }];
  if (selected) chat.tool_choice = { type: 'function', function: { name } };
  return { body: chat, source, name, options, clientTools, clientInput };
}

/** Search runs on the gateway; only client-owned calls leave this loop. */
export async function runHostedTools(plan: HostedToolPlan, model: string, streaming: boolean, signal: AbortSignal,
  ask: (body: Wire) => Promise<TransportReply>, search: WebSearchExecutor): Promise<TransportReply> {
  const body: Wire = { ...plan.body, messages: [...list(plan.body.messages)] };
  const searches: SearchRecord[] = []; const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const configured = Number(plan.options.max_uses);
  const limit = Number.isInteger(configured) && configured >= 0 ? Math.min(6, configured) : 6;
  let answer: Wire | undefined;
  for (let round = 0; round <= 6; round++) {
    signal.throwIfAborted();
    const response = await replyJson(await ask({ ...body, stream: false }), signal);
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) usage[key] += Number(response.usage?.[key]) || 0;
    const message = response.choices?.[0]?.message;
    if (!message) throw new RouterError('UPSTREAM_INVALID_RESPONSE', 502);
    const calls = list(message.tool_calls); const hosted = calls.filter(c => c.function?.name === plan.name);
    if (!hosted.length) { answer = response; break; }
    const clientCalls = calls.filter(c => c.function?.name !== plan.name);
    // Every executed server call gets a result before the model continues.
    // Client calls are returned to the client, never executed by the gateway.
    body.messages.push({ ...message, tool_calls: hosted });
    for (const call of hosted) {
      let query = ''; let result: WebSearchResult;
      try {
        const args = JSON.parse(call.function.arguments);
        if (typeof args?.query !== 'string' || !args.query.trim() || args.query.length > 4096) throw new Error('invalid query');
        query = args.query.trim();
        if (searches.length >= limit) result = { text: 'Search budget exhausted. Answer using existing sources.', sources: [], error: 'SEARCH_LIMIT' };
        else result = await search(query, plan.options, signal);
      } catch {
        signal.throwIfAborted(); result = { text: 'Web search failed. Do not claim to have searched successfully.', sources: [], error: 'SEARCH_UNAVAILABLE' };
      }
      const record = { ...result, id: 'ws_' + randomUUID().replaceAll('-', ''), query }; searches.push(record);
      if (searches.length > 24) throw new RouterError('HOSTED_TOOL_LIMIT', 400);
      body.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    delete body.tool_choice;
    if (clientCalls.length) {
      answer = { ...response, choices: [{ ...response.choices[0], message: { ...message, tool_calls: clientCalls } }] }; break;
    }
    if (round === 6) throw new RouterError('HOSTED_TOOL_LIMIT', 400);
    if (searches.length >= limit || searches.some(s => s.error)) body.tools = list(body.tools).filter(t => t.function?.name !== plan.name);
  }
  if (!answer) throw new RouterError('UPSTREAM_INVALID_RESPONSE', 502);
  answer.usage = { ...answer.usage, ...usage };
  const native = await replyJson(convertReply(jsonReply(answer), 'chat', plan.source, model, false, signal, undefined, plan.clientTools, plan.clientInput), signal);
  return hostedReply(native, plan.source, model, streaming, searches, signal);
}

function hostedReply(value: Wire, protocol: Protocol, model: string, streaming: boolean, searches: SearchRecord[], signal: AbortSignal): TransportReply {
  const sources = searches.flatMap(s => s.sources);
  if (protocol === 'responses') {
    const items = searches.map(s => ({ id: s.id, type: 'web_search_call', status: s.error ? 'failed' : 'completed', action: { type: 'search', query: s.query, sources: s.sources.map(h => ({ type: 'url', ...h })) }, ...(s.error ? { error: { code: s.error, message: s.text } } : {}) }));
    value.output = [...items, ...value.output];
    for (const item of value.output) if (item.type === 'message') for (const part of list(item.content)) if (part.type === 'output_text') {
      part.annotations = [...list(part.annotations), ...sources.filter(h => part.text.includes(h.url)).map(h => ({ type: 'url_citation', url: h.url, title: h.title, start_index: part.text.indexOf(h.url), end_index: part.text.indexOf(h.url) + h.url.length }))];
    }
    if (streaming) return streamReply(streamNativeResponse(value, model), signal);
  } else if (protocol === 'messages') {
    value.content = [...searches.flatMap(s => [{ type: 'server_tool_use', id: s.id, name: 'web_search', input: { query: s.query } }, { type: 'web_search_tool_result', tool_use_id: s.id, content: s.error ? { type: 'web_search_tool_result_error', error_code: s.error === 'SEARCH_LIMIT' ? 'max_uses_exceeded' : 'unavailable' } : s.sources.map(h => ({ type: 'web_search_result', url: h.url, title: h.title, encrypted_content: '' })) }]), ...value.content];
    if (streaming) return streamReply(messageFrames(value), signal);
  } else if (protocol === 'gemini') {
    if (value.candidates?.[0]) value.candidates[0].groundingMetadata = { webSearchQueries: searches.map(s => s.query), groundingChunks: sources.map(h => ({ web: { uri: h.url, title: h.title } })) };
    if (streaming) return streamReply([`data: ${JSON.stringify(value)}\n\n`], signal);
  } else if (streaming) {
    const encoder = new EventEncoder('chat', model);
    return streamReply((function* () { for (const event of jsonEvents(value, 'chat')) yield* encoder.push(event, true); yield* encoder.finish(); })(), signal);
  }
  return jsonReply(value);
}
function streamReply(frames: Iterable<string>, signal: AbortSignal): TransportReply {
  const body = Readable.from((async function* () { for (const frame of frames) { signal.throwIfAborted(); yield frame; } })());
  return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body, dispose() { body.destroy(); } };
}
function* messageFrames(value: Wire): Generator<string> {
  const frame = (v: Wire) => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`;
  yield frame({ type: 'message_start', message: { ...value, content: [], stop_reason: null, stop_sequence: null, usage: { ...value.usage, output_tokens: 0 } } });
  for (const [index, block] of value.content.entries()) {
    // Snapshots preserve tool results; text and client tools emit normal deltas.
    const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } : block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking } : undefined;
    yield frame({ type: 'content_block_start', index, content_block: delta ? { ...block, ...(block.type === 'text' ? { text: '' } : block.type === 'tool_use' ? { input: {} } : { thinking: '' }) } : block });
    if (delta) yield frame({ type: 'content_block_delta', index, delta });
    yield frame({ type: 'content_block_stop', index });
  }
  yield frame({ type: 'message_delta', delta: { stop_reason: value.stop_reason, stop_sequence: null }, usage: { output_tokens: value.usage.output_tokens } });
  yield frame({ type: 'message_stop' });
}

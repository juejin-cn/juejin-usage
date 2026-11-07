import { geminiToChat, chatToGemini } from './gemini.js';
import { portableResponseTools } from './response-tools.js';
import type { NativeExchange } from './native-state.js';
import { RouterError, type Protocol } from '../config.js';

// Wire objects are validated at the protocol boundary, never retained in traces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export const list = (v: unknown): Wire[] => Array.isArray(v) ? v : [];
export function unsupported(feature: string): never { throw new RouterError(`PROTOCOL_CONVERSION_UNSUPPORTED_${feature}`, 400); }
const text = (v: unknown): string => typeof v === 'string' ? v : list(v).map(p => { if (p.type !== 'text' && p.type !== 'input_text' && p.type !== 'output_text') unsupported('CONTENT'); return p.text ?? ''; }).join('\n');
/** Claude's first system block is SDK billing metadata, not a user instruction.
 * Keep it on native Messages requests; other providers can reject the marker. */
function portableSystem(value: unknown): string {
  if (!Array.isArray(value)) return text(value);
  return text(value.filter((p, index) => !(index === 0 && p.type === 'text' && typeof p.text === 'string'
    && sdkBillingBlock(p.text))));
}
function sdkBillingBlock(value: string): boolean {
  if (/[\r\n]/.test(value) || value.length > 4096) return false;
  const fields = value.split(';').map(field => field.trim());
  if (fields.at(-1) === '') fields.pop();
  return fields.length >= 2 && /^x-anthropic-billing-header: cc_version=[\w.+-]+$/.test(fields[0])
    && /^cc_entrypoint=[\w.-]+$/.test(fields[1])
    && fields.slice(2).every(field => /^(?:cc_[a-z0-9_]+|cch)=[^;\r\n]+$/.test(field));
}
function parts(value: unknown, source: Protocol): Wire[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return list(value).map(p => {
    if (['text', 'input_text', 'output_text'].includes(p.type)) return { type: 'text', text: p.text };
    if (p.type === 'image_url') return p;
    if (p.type === 'input_image' && p.image_url) return { type: 'image_url', image_url: { url: p.image_url, ...(p.detail ? { detail: p.detail } : {}) } };
    if (source === 'messages' && p.type === 'image') {
      if (p.source?.type === 'url') return { type: 'image_url', image_url: { url: p.source.url } };
      if (p.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${p.source.media_type};base64,${p.source.data}` } };
    }
    return unsupported('CONTENT');
  });
}
function anthropicParts(content: unknown): Wire[] {
  return parts(content, 'chat').map(p => {
    if (p.type === 'text') return p;
    const url = String(p.image_url.url); const data = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
    return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url } };
  });
}
function responseParts(content: unknown, assistant: boolean): Wire[] {
  return parts(content, 'chat').map(p => p.type === 'text' ? { type: assistant ? 'output_text' : 'input_text', text: p.text, ...(assistant ? { annotations: [] } : {}) }
    : assistant ? unsupported('ASSISTANT_IMAGE') : { type: 'input_image', image_url: p.image_url.url, ...(p.image_url.detail ? { detail: p.image_url.detail } : {}) });
}
function toChat(body: Wire, source: Protocol): Wire {
  if (source === 'responses') body = portableResponseTools(body);
  if (source === 'gemini') return geminiToChat(body);
  if (source === 'chat') {
    if (body.n && body.n !== 1) unsupported('MULTIPLE_CHOICES');
    if (body.functions || body.function_call) unsupported('LEGACY_FUNCTIONS');
    for (const t of list(body.tools)) if (t.type !== 'function' || t.defer_loading || t.function?.defer_loading) unsupported('TOOL_FEATURE');
    for (const m of list(body.messages)) parts(m.content, 'chat');
    return { ...body, messages: list(body.messages).map(m => ({ ...m })) };
  }
  const messages: Wire[] = [];
  if (source === 'messages') {
    if (body.system) { const system = portableSystem(body.system); if (system) messages.push({ role: 'system', content: system }); }
    for (const m of list(body.messages)) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : list(m.content);
      const content: Wire[] = []; const calls: Wire[] = []; const results: Wire[] = []; let reasoning = '';
      for (const p of blocks) {
        if (p.type === 'tool_use') calls.push({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } });
        else if (p.type === 'tool_result') results.push({ role: 'tool', tool_call_id: p.tool_use_id, content: (p.is_error ? 'Tool error: ' : '') + text(p.content) });
        else if (p.type === 'thinking') { if (p.signature) unsupported('SIGNED_REASONING_HISTORY'); reasoning += p.thinking ?? ''; }
        else content.push(...parts([p], source));
      }
      // Tool results must precede accompanying user text in Chat's history.
      messages.push(...results);
      if (content.length || calls.length || reasoning) messages.push({ role: m.role, content: content.length ? content : null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) });
    }
  } else {
    if (body.previous_response_id || body.conversation) unsupported('STATEFUL_RESPONSES');
    if (body.background) unsupported('BACKGROUND');
    if (body.store === true) unsupported('RESPONSE_STORAGE');
    if (body.instructions) messages.push({ role: 'system', content: body.instructions });
    if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input });
    else for (const item of list(body.input)) {
      if (item.type === 'function_call') messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] });
      else if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: text(item.output) });
      else if (item.type === 'reasoning') {
        if (item.encrypted_content) unsupported('ENCRYPTED_REASONING');
        const reasoning = list(item.summary).map(p => p.text ?? '').join('');
        if (reasoning) messages.push({ role: 'assistant', content: null, reasoning_content: reasoning });
      } else if (!item.type || item.type === 'message') messages.push({ role: item.role, content: parts(item.content, source) });
      else unsupported('INPUT_ITEM');
    }
  }
  const tools = list(body.tools).map(t => {
    if (source === 'responses' && t.type !== 'function' || source === 'messages' && t.type && t.type !== 'custom') unsupported('BUILTIN_TOOL');
    if (t.defer_loading || t.cache_control?.type && t.cache_control.type !== 'ephemeral') unsupported('TOOL_FEATURE');
    return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters ?? t.input_schema ?? { type: 'object', properties: {} }, ...(t.strict !== undefined ? { strict: t.strict } : {}) } };
  });
  let choice = body.tool_choice;
  if (choice && typeof choice === 'object') {
    if (choice.type === 'tool' || choice.type === 'function') choice = { type: 'function', function: { name: choice.name } };
    else if (['auto', 'none', 'any'].includes(choice.type)) choice = choice.type === 'any' ? 'required' : choice.type;
    else unsupported('TOOL_CHOICE');
  }
  const merged: Wire[] = [];
  for (const m of messages) {
    const previous = merged.at(-1);
    if (m.role === 'assistant' && previous?.role === 'assistant' && !m.content && !previous.content) {
      previous.tool_calls = [...(previous.tool_calls ?? []), ...(m.tool_calls ?? [])];
      previous.reasoning_content = (previous.reasoning_content ?? '') + (m.reasoning_content ?? '');
    } else merged.push(m);
  }
  const out: Wire = { model: body.model, messages: merged, stream: body.stream === true };
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls']) if (body[key] !== undefined) out[key] = body[key];
  if (body.tool_choice?.disable_parallel_tool_use !== undefined) out.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
  if (tools.length) out.tools = tools;
  if (choice !== undefined) out.tool_choice = choice;
  const max = body.max_tokens ?? body.max_output_tokens;
  if (max !== undefined) out.max_tokens = max;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  const effort = body.reasoning?.effort ?? body.output_config?.effort;
  if (effort) out.reasoning_effort = effort;
  if (body.thinking?.type === 'enabled' && !effort) out.reasoning_effort = 'high';
  if (body.text?.format && body.text.format.type !== 'text') {
    const { type, ...format } = body.text.format;
    out.response_format = type === 'json_schema' ? { type, json_schema: format } : { type };
  }
  return out;
}
export function convertRequest(body: Wire, source: Protocol, target: Protocol, exchange?: NativeExchange): Wire {
  if (source === target && !exchange) return body;
  if (exchange) body = structuredClone(body);
  if (body.audio || body.modalities?.some((m: string) => m !== 'text')) unsupported('AUDIO');
  if (body.logprobs || body.top_logprobs || body.logit_bias || body.frequency_penalty || body.presence_penalty || body.seed !== undefined) unsupported('SAMPLING_OPTIONS');
  const chat = toChat(body, source);
  exchange?.restore(chat);
  if (target === 'gemini') return chatToGemini(chat);
  if (target === 'chat') {
    for (const m of list(chat.messages)) delete m.native_reasoning;
    if (chat.stream) chat.stream_options = { include_usage: true };
    return chat;
  }
  const out: Wire = { model: chat.model, stream: chat.stream === true };
  for (const key of ['temperature', 'top_p']) if (chat[key] !== undefined) out[key] = chat[key];
  if (target === 'responses') {
    out.store = false;
    out.input = list(chat.messages).flatMap((m): Wire[] => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: text(m.content) }];
      const result: Wire[] = [...(m.native_reasoning ?? [])];
      if (m.reasoning_content && !m.native_reasoning?.length) result.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: m.reasoning_content }] });
      if (m.content) result.push({ type: 'message', role: m.role, content: responseParts(m.content, m.role === 'assistant') });
      for (const call of list(m.tool_calls)) result.push({ type: 'function_call', call_id: call.id, ...(call.native_item_id ? { id: call.native_item_id } : {}), name: call.function.name, arguments: call.function.arguments });
      return result;
    });
    if (chat.max_tokens !== undefined || chat.max_completion_tokens !== undefined) out.max_output_tokens = chat.max_completion_tokens ?? chat.max_tokens;
    if (chat.stop) unsupported('STOP_SEQUENCES');
    if (chat.reasoning_effort) out.reasoning = { effort: chat.reasoning_effort };
    if (chat.parallel_tool_calls !== undefined) out.parallel_tool_calls = chat.parallel_tool_calls;
    if (chat.tools) out.tools = list(chat.tools).map(t => { if (t.type !== 'function') unsupported('BUILTIN_TOOL'); return { type: 'function', ...t.function }; });
    if (chat.tool_choice !== undefined) out.tool_choice = typeof chat.tool_choice === 'string' ? chat.tool_choice : { type: 'function', name: chat.tool_choice.function.name };
    if (chat.response_format) out.text = { format: chat.response_format.type === 'json_schema' ? { type: 'json_schema', ...chat.response_format.json_schema } : chat.response_format };
  } else {
    if (chat.response_format && chat.response_format.type !== 'text') unsupported('STRUCTURED_OUTPUT');
    out.max_tokens = chat.max_completion_tokens ?? chat.max_tokens ?? 4096;
    out.messages = [];
    const system: string[] = [];
    for (const m of list(chat.messages)) {
      if (m.role === 'system' || m.role === 'developer') { system.push(text(m.content)); continue; }
      let content: Wire[];
      if (m.role === 'tool') content = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) }];
      else {
        content = [...(m.native_reasoning ?? []), ...anthropicParts(m.content)];
        // Unsigned reasoning from another vendor cannot be replayed as signed Anthropic thinking.
        for (const call of list(m.tool_calls)) {
          let input: unknown; try { input = JSON.parse(call.function.arguments || '{}'); } catch { throw new RouterError('INVALID_TOOL_ARGUMENTS', 400); }
          content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
        }
      }
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const previous = out.messages.at(-1);
      if (previous?.role === role) previous.content.push(...content); else if (content.length) out.messages.push({ role, content });
    }
    if (system.length) out.system = system.join('\n\n');
    if (chat.stop) out.stop_sequences = Array.isArray(chat.stop) ? chat.stop : [chat.stop];
    if (chat.tools) out.tools = list(chat.tools).map(t => { if (t.type !== 'function') unsupported('BUILTIN_TOOL'); return { name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object', properties: {} } }; });
    if (chat.tool_choice !== undefined) out.tool_choice = typeof chat.tool_choice === 'string' ? { type: chat.tool_choice === 'required' ? 'any' : chat.tool_choice } : { type: 'tool', name: chat.tool_choice.function.name };
    if (chat.parallel_tool_calls === false) out.tool_choice = { ...(out.tool_choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
    // A portable effort hint cannot safely pick a vendor-specific Anthropic budget.
    if (chat.reasoning_effort && chat.reasoning_effort !== 'none') unsupported('ANTHROPIC_THINKING_BUDGET');
  }
  return out;
}

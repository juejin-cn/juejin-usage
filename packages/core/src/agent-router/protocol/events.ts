import { RouterError, type Protocol } from '../config.js';
import { list, type Wire } from './request.js';

export interface Usage { input: number; output: number; cached: number; reasoning: number }
export type Event = { kind: 'text' | 'reasoning'; key: string; text: string } | { kind: 'tool'; key: string; id?: string; name?: string; args?: string } | { kind: 'usage'; usage: Usage } | { kind: 'finish'; reason: string };
export function usage(v: Wire = {}, protocol: Protocol): Usage {
  return { input: Number(v.prompt_tokens ?? v.input_tokens ?? 0) + (protocol === 'messages' ? Number(v.cache_read_input_tokens ?? 0) + Number(v.cache_creation_input_tokens ?? 0) : 0), output: Number(v.completion_tokens ?? v.output_tokens ?? 0), cached: Number(v.prompt_tokens_details?.cached_tokens ?? v.input_tokens_details?.cached_tokens ?? v.cache_read_input_tokens ?? 0), reasoning: Number(v.completion_tokens_details?.reasoning_tokens ?? v.output_tokens_details?.reasoning_tokens ?? 0) };
}
export function checkError(v: Wire): void {
  if (v.error || v.type === 'error' || v.type === 'response.failed') {
    const error = v.error ?? v.response?.error ?? {};
    const status = Number(error.status ?? error.status_code);
    const code = String(error.type ?? error.code ?? '');
    const mapped = status >= 400 && status <= 599 ? status : /rate_limit|quota/.test(code) ? 429 : /authentication|invalid_api_key/.test(code) ? 401 : /invalid_request/.test(code) ? 400 : /overloaded/.test(code) ? 503 : 502;
    throw new RouterError('UPSTREAM_PROTOCOL_ERROR', mapped);
  }
}
export function* jsonEvents(v: Wire, protocol: Protocol): Generator<Event> {
  checkError(v);
  if (protocol === 'chat') {
    const choice = v.choices?.[0]; if (!choice?.message) throw new RouterError('UPSTREAM_INVALID_RESPONSE', 502);
    const m = choice.message;
    if (m.reasoning_content || m.reasoning) yield { kind: 'reasoning', key: 'r', text: m.reasoning_content ?? m.reasoning };
    if (m.content) yield { kind: 'text', key: 't', text: typeof m.content === 'string' ? m.content : list(m.content).map(p => p.text ?? '').join('') };
    if (m.refusal) yield { kind: 'text', key: 'refusal', text: m.refusal };
    for (const [i, c] of list(m.tool_calls).entries()) yield { kind: 'tool', key: `f${i}`, id: c.id, name: c.function?.name, args: c.function?.arguments ?? '' };
    yield { kind: 'finish', reason: choice.finish_reason ?? 'stop' };
  } else if (protocol === 'messages') {
    if (v.type !== 'message' || !Array.isArray(v.content)) throw new RouterError('UPSTREAM_INVALID_RESPONSE', 502);
    for (const [i, b] of list(v.content).entries()) {
      if (b.type === 'text') yield { kind: 'text', key: String(i), text: b.text };
      else if (b.type === 'thinking') yield { kind: 'reasoning', key: String(i), text: b.thinking };
      else if (b.type === 'tool_use') yield { kind: 'tool', key: String(i), id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) };
      else throw new RouterError('UPSTREAM_UNSUPPORTED_CONTENT', 502);
    }
    yield { kind: 'finish', reason: v.stop_reason ?? 'end_turn' };
  } else {
    if (!Array.isArray(v.output)) throw new RouterError('UPSTREAM_INVALID_RESPONSE', 502);
    for (const [i, b] of list(v.output).entries()) {
      if (b.type === 'function_call') yield { kind: 'tool', key: String(i), id: b.call_id, name: b.name, args: b.arguments ?? '' };
      else if (b.type === 'reasoning') yield { kind: 'reasoning', key: String(i), text: list(b.summary).map(p => p.text ?? '').join('') };
      else if (b.type === 'message') for (const [j, p] of list(b.content).entries()) {
        if (p.type !== 'output_text' && p.type !== 'refusal') throw new RouterError('UPSTREAM_UNSUPPORTED_CONTENT', 502);
        yield { kind: 'text', key: `${i}:${j}`, text: p.text ?? p.refusal ?? '' };
      } else throw new RouterError('UPSTREAM_UNSUPPORTED_CONTENT', 502);
    }
    yield { kind: 'finish', reason: v.status === 'incomplete' ? 'length' : 'stop' };
  }
  if (v.usage) yield { kind: 'usage', usage: usage(v.usage, protocol) };
}
/** Stateful only within one upstream response. Never retains conversation history. */
export class EventDecoder {
  terminal = false;
  private currentUsage: Wire = {};
  private args = new Set<string>();
  *push(v: Wire, p: Protocol): Generator<Event> {
    checkError(v);
    if (p === 'chat') {
      if (v.usage) yield { kind: 'usage', usage: usage(v.usage, p) };
      const c = v.choices?.[0]; if (!c) return;
      const d = c.delta ?? {};
      if (d.reasoning_content || d.reasoning) yield { kind: 'reasoning', key: 'r', text: d.reasoning_content ?? d.reasoning };
      if (d.content) yield { kind: 'text', key: 't', text: d.content };
      if (d.refusal) yield { kind: 'text', key: 'refusal', text: d.refusal };
      for (const t of list(d.tool_calls)) yield { kind: 'tool', key: `f${t.index ?? 0}`, id: t.id, name: t.function?.name, args: t.function?.arguments };
      if (c.finish_reason) { this.terminal = true; yield { kind: 'finish', reason: c.finish_reason }; }
    } else if (p === 'messages') {
      if (v.type === 'message_start') { this.currentUsage = { ...v.message?.usage }; yield { kind: 'usage', usage: usage(this.currentUsage, p) }; }
      if (v.type === 'content_block_start') {
        const b = v.content_block ?? {};
        if (b.type === 'tool_use') yield { kind: 'tool', key: String(v.index), id: b.id, name: b.name, ...(b.input && Object.keys(b.input).length ? { args: JSON.stringify(b.input) } : {}) };
        else if (b.type === 'text' && b.text) yield { kind: 'text', key: String(v.index), text: b.text };
        else if (b.type === 'thinking' && b.thinking) yield { kind: 'reasoning', key: String(v.index), text: b.thinking };
        else if (!['text', 'thinking'].includes(b.type)) throw new RouterError('UPSTREAM_UNSUPPORTED_CONTENT', 502);
      }
      if (v.type === 'content_block_delta') {
        const d = v.delta ?? {};
        if (d.type === 'text_delta') yield { kind: 'text', key: String(v.index), text: d.text };
        else if (d.type === 'thinking_delta') yield { kind: 'reasoning', key: String(v.index), text: d.thinking };
        else if (d.type === 'input_json_delta') yield { kind: 'tool', key: String(v.index), args: d.partial_json };
        else if (d.type !== 'signature_delta') throw new RouterError('UPSTREAM_UNSUPPORTED_CONTENT', 502);
      }
      if (v.type === 'message_delta') {
        this.currentUsage = { ...this.currentUsage, ...v.usage }; yield { kind: 'usage', usage: usage(this.currentUsage, p) };
        if (v.delta?.stop_reason) yield { kind: 'finish', reason: v.delta.stop_reason };
      }
      if (v.type === 'message_stop') this.terminal = true;
    } else {
      const key = String(v.output_index ?? 0);
      if (v.type === 'response.output_item.added') {
        if (v.item?.type === 'function_call') {
          if (v.item.arguments) this.args.add(key);
          yield { kind: 'tool', key, id: v.item.call_id, name: v.item.name, args: v.item.arguments ?? '' };
        } else if (!['message', 'reasoning'].includes(v.item?.type)) throw new RouterError('UPSTREAM_UNSUPPORTED_CONTENT', 502);
      }
      if (v.type === 'response.output_text.delta' || v.type === 'response.refusal.delta') yield { kind: 'text', key: `${key}:${v.content_index ?? 0}`, text: v.delta };
      if (v.type === 'response.reasoning_summary_text.delta') yield { kind: 'reasoning', key, text: v.delta };
      if (v.type === 'response.function_call_arguments.delta') { this.args.add(key); yield { kind: 'tool', key, args: v.delta }; }
      if (v.type === 'response.function_call_arguments.done' && !this.args.has(key)) yield { kind: 'tool', key, args: v.arguments ?? '' };
      if (v.type === 'response.completed' || v.type === 'response.incomplete') {
        this.terminal = true;
        if (v.response?.usage) yield { kind: 'usage', usage: usage(v.response.usage, p) };
        yield { kind: 'finish', reason: v.type === 'response.incomplete' ? 'length' : 'stop' };
      }
    }
  }
}

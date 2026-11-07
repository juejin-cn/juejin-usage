import type { Readable } from 'node:stream';
import { RouterError } from '../config.js';
import { checkError } from './events.js';
import { wireFrames } from './sse.js';
import type { Wire } from './request.js';

const invalid = (): never => { throw new RouterError('UPSTREAM_INVALID_RESPONSE', 502); };
function position(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 1024) throw new RouterError('UPSTREAM_INVALID_OUTPUT_INDEX', 502);
  return Number(value);
}
/** Native collection keeps full items, opaque state and vendor extensions. It is
 * deliberately separate from the lossy cross-protocol event representation. */
export async function collectNativeResponse(body: Readable, signal: AbortSignal, model: string): Promise<Wire> {
  let metadata: Wire = {}, terminal: Wire | undefined, status: string | undefined;
  const items = new Map<number, Wire>(), done = new Set<number>();
  const item = (v: Wire, type: string): Wire => {
    const index = position(v.output_index ?? 0);
    let value = items.get(index);
    if (!value) { value = { type, ...(v.item_id ? { id: v.item_id } : {}), ...(type === 'message' ? { role: 'assistant', content: [] } : type === 'reasoning' ? { summary: [] } : {}) }; items.set(index, value); }
    if (value.type !== type) invalid();
    return value;
  };
  const part = (v: Wire, reasoning: boolean): Wire => {
    const parent = item(v, reasoning ? 'reasoning' : 'message');
    const list: Wire[] = parent[reasoning ? 'summary' : 'content'] ??= [];
    if (!Array.isArray(list)) invalid();
    const index = position((reasoning ? v.summary_index : v.content_index) ?? 0);
    const refusal = v.type.startsWith('response.refusal.');
    return list[index] ??= { type: reasoning ? 'summary_text' : refusal ? 'refusal' : 'output_text', ...(reasoning || !refusal ? { text: '' } : { refusal: '' }) };
  };
  for await (const { value: v } of wireFrames(body, signal)) {
    if (!v) continue;
    checkError(v);
    if (v.response && typeof v.response === 'object') checkError(v.response);
    if (status && String(v.type).startsWith('response.')) throw new RouterError('UPSTREAM_EVENT_AFTER_FINISH', 502);
    if (v.type === 'response.created' || v.type === 'response.in_progress') {
      if (!v.response || typeof v.response !== 'object' || Array.isArray(v.response)) invalid();
      metadata = { ...metadata, ...v.response };
    } else if (v.type === 'response.output_item.added' || v.type === 'response.output_item.done') {
      const index = position(v.output_index);
      if (!v.item || typeof v.item !== 'object' || Array.isArray(v.item) || typeof v.item.type !== 'string') invalid();
      items.set(index, structuredClone(v.item));
      if (v.type === 'response.output_item.done') done.add(index);
    } else if (['response.output_text.delta', 'response.refusal.delta', 'response.reasoning_summary_text.delta', 'response.output_text.done', 'response.refusal.done', 'response.reasoning_summary_text.done'].includes(v.type)) {
      const field = v.type.startsWith('response.refusal.') ? 'refusal' : 'text';
      const value = v.type.endsWith('.delta') ? v.delta : v[field];
      if (typeof value !== 'string') invalid();
      const p = part(v, v.type.startsWith('response.reasoning_summary_text.'));
      p[field] = v.type.endsWith('.delta') ? String(p[field] ?? '') + value : value;
    } else if (['response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done'].includes(v.type)) {
      const reasoning = v.type.startsWith('response.reasoning_summary_part.');
      const parent = item(v, reasoning ? 'reasoning' : 'message');
      if (!v.part || typeof v.part !== 'object' || Array.isArray(v.part)) invalid();
      const parts = parent[reasoning ? 'summary' : 'content'] ??= [];
      if (!Array.isArray(parts)) invalid();
      parts[position((reasoning ? v.summary_index : v.content_index) ?? 0)] = structuredClone(v.part);
    } else if (['response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done'].includes(v.type)) {
      const custom = v.type.startsWith('response.custom_tool_call_input.');
      const parent = item(v, custom ? 'custom_tool_call' : 'function_call'), field = custom ? 'input' : 'arguments';
      const text = v.type.endsWith('.delta') ? v.delta : v[field];
      if (typeof text !== 'string') invalid();
      parent[field] = v.type.endsWith('.delta') ? String(parent[field] ?? '') + text : text;
    } else if (v.type === 'response.completed' || v.type === 'response.incomplete') {
      if (!v.response || typeof v.response !== 'object' || Array.isArray(v.response) || v.response.error) invalid();
      status = v.type === 'response.completed' ? 'completed' : 'incomplete';
      if (v.response.status !== undefined && v.response.status !== status) invalid();
      terminal = v.response;
    }
  }
  if (!terminal || !status) throw new RouterError('UPSTREAM_TRUNCATED_STREAM', 502);
  let output = terminal.output;
  if (status === 'completed' && Array.isArray(output) && !output.length && items.size) throw new RouterError('UPSTREAM_INCOMPLETE_NATIVE_RESPONSE', 502);
  if (output == null) {
    output = [...items].sort(([a], [b]) => a - b).map(([index, value]) => {
      if (!done.has(index) && !['message', 'reasoning', 'function_call', 'custom_tool_call'].includes(value.type)) throw new RouterError('UPSTREAM_INCOMPLETE_NATIVE_ITEM', 502);
      if (!done.has(index) && ['function_call', 'custom_tool_call'].includes(value.type) && (typeof value.call_id !== 'string' || !value.call_id || typeof value.name !== 'string' || !value.name)) throw new RouterError('UPSTREAM_INCOMPLETE_NATIVE_ITEM', 502);
      return value;
    });
  }
  if (!Array.isArray(output)) invalid();
  return { object: 'response', ...metadata, ...terminal, output, status, model };
}

export async function readNativeResponse(body: Readable, signal: AbortSignal): Promise<Wire> {
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of body) {
    if (signal.aborted) throw signal.reason;
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > 32 * 1024 * 1024) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
    chunks.push(value);
  }
  if (signal.aborted) throw signal.reason;
  let value: Wire; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new RouterError('UPSTREAM_INVALID_JSON', 502); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}

/** A JSON-only Responses upstream still supplies legal native SSE to streaming
 * callers. Complete item snapshots retain unknown types and opaque fields. */
export function* streamNativeResponse(value: Wire, model: string): Generator<string> {
  checkError(value);
  if (!Array.isArray(value.output) || !['completed', 'incomplete'].includes(value.status)) invalid();
  let sequence = 0;
  const frame = (v: Wire) => `event: ${v.type}\ndata: ${JSON.stringify({ ...v, sequence_number: sequence++ })}\n\n`;
  const response: Wire = { ...value, model };
  const opening = { ...response, status: 'in_progress', output: [], usage: null };
  yield frame({ type: 'response.created', response: opening });
  yield frame({ type: 'response.in_progress', response: opening });
  for (const [index, item] of response.output.entries()) {
    if (!item || typeof item !== 'object' || typeof item.type !== 'string') invalid();
    const common = { item_id: item.id, output_index: index };
    const initial = { ...item, ...(item.type === 'message' ? { content: [] } : item.type === 'reasoning' ? { summary: [] } : item.type === 'function_call' ? { arguments: '' } : item.type === 'custom_tool_call' ? { input: '' } : {}) };
    yield frame({ type: 'response.output_item.added', output_index: index, item: initial });
    if (item.type === 'message') for (const [partIndex, part] of (item.content ?? []).entries()) {
      const fields = { ...common, content_index: partIndex };
      const field = part.type === 'refusal' ? 'refusal' : 'text';
      const textual = part.type === 'output_text' || part.type === 'refusal';
      yield frame({ type: 'response.content_part.added', ...fields, part: textual ? { ...part, [field]: '' } : part });
      if (textual) {
        yield frame({ type: part.type === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta', ...fields, delta: part[field] });
        yield frame({ type: part.type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', ...fields, [field]: part[field] });
      }
      yield frame({ type: 'response.content_part.done', ...fields, part });
    }
    else if (item.type === 'reasoning') for (const [summaryIndex, part] of (item.summary ?? []).entries()) {
      const fields = { ...common, summary_index: summaryIndex };
      yield frame({ type: 'response.reasoning_summary_part.added', ...fields, part: { ...part, text: '' } });
      yield frame({ type: 'response.reasoning_summary_text.delta', ...fields, delta: part.text });
      yield frame({ type: 'response.reasoning_summary_text.done', ...fields, text: part.text });
      yield frame({ type: 'response.reasoning_summary_part.done', ...fields, part });
    }
    else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const custom = item.type === 'custom_tool_call', field = custom ? 'input' : 'arguments';
      yield frame({ type: custom ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', ...common, delta: item[field] });
      yield frame({ type: custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', ...common, [field]: item[field], ...(!custom ? { name: item.name } : {}) });
    }
    yield frame({ type: 'response.output_item.done', output_index: index, item });
  }
  yield frame({ type: `response.${response.status}`, response });
}

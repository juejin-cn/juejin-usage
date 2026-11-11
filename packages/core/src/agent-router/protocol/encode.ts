import { randomUUID } from 'node:crypto';
import { RouterError, type Protocol } from '../config.js';
import type { Event, Usage } from './events.js';
import type { Wire } from './request.js';
import type { NativeExchange } from './native-state.js';
import { responseToolMap, customToolInput, type ResponseTool } from './response-tools.js';
interface Block { key: string; type: 'text' | 'reasoning' | 'tool'; text: string; id: string; nativeId: string; native?: Wire; name: string; index: number; toolIndex: number; started: boolean }
const MAX_RESPONSE = 16 * 1024 * 1024;
export class EventEncoder {
  private id = randomUUID().replaceAll('-', '');
  private created = Math.floor(Date.now() / 1000);
  private blocks: Block[] = [];
  private usage: Usage = { input: 0, output: 0, cached: 0, reasoning: 0 };
  private reason = 'stop';
  private sequence = 0;
  private bytes = 0;
  private started = false;
  private nativeReasoning = new Map<string, Wire>();
  private completed = false;
  private finishing = false;
  private tools: Map<string, ResponseTool>;
  constructor(private protocol: Protocol, private model: string, private exchange?: NativeExchange, private nativeOutput = false, clientTools?: unknown, clientInput?: unknown) { this.tools = responseToolMap(clientTools, clientInput); }
  private frame(value: Wire): string {
    if (this.protocol === 'responses') value.sequence_number = this.sequence++;
    return `${this.protocol === 'chat' || this.protocol === 'gemini' ? '' : `event: ${value.type}\n`}data: ${JSON.stringify(value)}\n\n`;
  }
  private chat(delta: Wire, finish: string | null = null, usage?: Wire): Wire {
    return { id: `chatcmpl-${this.id}`, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
  }
  private chatUsage(): Wire { return { prompt_tokens: this.usage.input, completion_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output, prompt_tokens_details: { cached_tokens: this.usage.cached, ...(this.usage.cacheWrite !== undefined ? { cache_write_tokens: this.usage.cacheWrite } : {}) }, completion_tokens_details: { reasoning_tokens: this.usage.reasoning } }; }
  private messagesUsage(): Wire { return { input_tokens: Math.max(0, this.usage.input - this.usage.cached - (this.usage.cacheWrite ?? 0)), output_tokens: this.usage.output, cache_read_input_tokens: this.usage.cached, ...(this.usage.cacheWrite !== undefined ? { cache_creation_input_tokens: this.usage.cacheWrite } : {}) }; }
  private geminiUsage(): Wire { return { promptTokenCount: this.usage.input, candidatesTokenCount: Math.max(0, this.usage.output - this.usage.reasoning), thoughtsTokenCount: this.usage.reasoning, cachedContentTokenCount: this.usage.cached, totalTokenCount: this.usage.input + this.usage.output }; }
  private geminiPart(b: Block): Wire {
    const native = this.nativeOutput ? this.nativeReasoning.get(b.key) : undefined;
    return b.type === 'tool' ? { functionCall: { ...(!b.native?.native_id_absent ? { id: b.id } : {}), name: b.name, args: JSON.parse(b.text || '{}') }, ...(this.nativeOutput && b.native?.extra_content?.google?.thought_signature ? { thoughtSignature: b.native.extra_content.google.thought_signature } : {}) } : { text: b.text, ...(b.type === 'reasoning' ? { thought: true } : {}), ...(native?.thoughtSignature ? { thoughtSignature: native.thoughtSignature } : {}) };
  }
  private completeState(): void {
    if (this.completed) return;
    this.exchange?.complete(this.blocks.filter(b => b.type === 'tool').map(b => ({ id: b.id, nativeId: b.nativeId, name: b.name, args: b.text || '{}', metadata: b.native })), [...this.nativeReasoning.values()].filter(v => v.type !== 'thinking' || v.signature));
    this.completed = true;
  }
  private item(b: Block, done: boolean): Wire {
    if (b.type === 'tool') {
      const tool = this.tools.get(b.name);
      if (tool?.search) return { type: 'tool_search_call', id: `tsc_${this.id}_${b.index}`, call_id: b.id, execution: 'client', arguments: done ? JSON.parse(b.text || '{}') : {}, status: done ? 'completed' : 'in_progress' };
      return { type: tool?.custom ? 'custom_tool_call' : 'function_call', id: this.nativeOutput && b.native?.native_item_id ? b.native.native_item_id : `${tool?.custom ? 'ctc' : 'fc'}_${this.id}_${b.index}`, call_id: b.id, name: tool?.name ?? b.name,
        ...(tool?.namespace ? { namespace: tool.namespace, ...(!tool.custom ? { encrypted_function_args: [] } : {}) } : {}),
        ...(tool?.custom ? { input: done ? customToolInput(b.text) : '' } : { arguments: done ? b.text || '{}' : '' }), status: done ? 'completed' : 'in_progress' };
    }
    if (b.type === 'reasoning' && this.nativeOutput && this.nativeReasoning.has(b.key)) return this.nativeReasoning.get(b.key)!;
    if (b.type === 'reasoning') return { type: 'reasoning', id: `rs_${this.id}_${b.index}`, summary: done ? [{ type: 'summary_text', text: b.text }] : [] };
    return { type: 'message', id: `msg_${this.id}_${b.index}`, status: done ? 'completed' : 'in_progress', role: 'assistant', content: done ? [{ type: 'output_text', text: b.text, annotations: [], logprobs: [] }] : [] };
  }
  private stopped(): string { return ['length', 'max_tokens'].includes(this.reason) ? 'length' : ['content_filter', 'refusal'].includes(this.reason) ? 'content_filter' : this.blocks.some(b => b.type === 'tool') ? 'tool_calls' : 'stop'; }
  private response(status: string): Wire {
    return { id: `resp_${this.id}`, object: 'response', created_at: this.created, status, error: null, incomplete_details: status === 'incomplete' ? { reason: this.stopped() === 'content_filter' ? 'content_filter' : 'max_output_tokens' } : null,
      model: this.model, output: status === 'in_progress' ? [] : this.blocks.map(b => this.item(b, true)), parallel_tool_calls: true, tool_choice: 'auto', tools: [], store: false,
      usage: status === 'in_progress' ? null : { input_tokens: this.usage.input, output_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output, input_tokens_details: { cached_tokens: this.usage.cached, ...(this.usage.cacheWrite !== undefined ? { cache_write_tokens: this.usage.cacheWrite } : {}) }, output_tokens_details: { reasoning_tokens: this.usage.reasoning } } };
  }
  json(): Wire {
    this.validateTools();
    this.completeState();
    if (this.protocol === 'gemini') return { candidates: [{ index: 0, content: { role: 'model', parts: this.blocks.map(b => this.geminiPart(b)) }, finishReason: this.stopped() === 'length' ? 'MAX_TOKENS' : this.stopped() === 'content_filter' ? 'SAFETY' : 'STOP' }], usageMetadata: this.geminiUsage(), modelVersion: this.model };
    if (this.protocol === 'responses') return this.response(['length', 'content_filter'].includes(this.stopped()) ? 'incomplete' : 'completed');
    if (this.protocol === 'messages') return { id: `msg_${this.id}`, type: 'message', role: 'assistant', model: this.model,
      content: this.blocks.map(b => this.nativeOutput && this.nativeReasoning.has(b.key) ? this.nativeReasoning.get(b.key)! : b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'reasoning' ? { type: 'thinking', thinking: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: JSON.parse(b.text || '{}') }),
      stop_reason: this.stopped() === 'length' ? 'max_tokens' : this.stopped() === 'tool_calls' ? 'tool_use' : this.stopped() === 'content_filter' ? 'refusal' : 'end_turn', stop_sequence: null, usage: this.messagesUsage() };
    const calls = this.blocks.filter(b => b.type === 'tool');
    const reasoning = this.blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('');
    return { id: `chatcmpl-${this.id}`, object: 'chat.completion', created: this.created, model: this.model, choices: [{ index: 0, message: { role: 'assistant', content: this.blocks.filter(b => b.type === 'text').map(b => b.text).join('') || null,
      ...(calls.length ? { tool_calls: calls.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.text || '{}' }, ...(this.nativeOutput ? b.native : {}) })) } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: this.stopped() }], usage: this.chatUsage() };
  }
  private validateTools(): void {
    for (const b of this.blocks.filter(b => b.type === 'tool')) {
      if (!b.id || !b.name) throw new RouterError('UPSTREAM_INVALID_TOOL_CALL', 502);
      if (this.tools.size && !this.tools.has(b.name)) throw new RouterError('UPSTREAM_UNKNOWN_TOOL', 502);
      try { const input = JSON.parse(b.text || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); } catch { throw new RouterError('UPSTREAM_INVALID_TOOL_ARGUMENTS', 502); }
      if (this.tools.get(b.name)?.custom) customToolInput(b.text);
    }
  }
  private *start(): Generator<string> {
    if (this.started) return; this.started = true;
    if (this.protocol === 'chat') yield this.frame(this.chat({ role: 'assistant', content: '' }));
    else if (this.protocol === 'messages') yield this.frame({ type: 'message_start', message: { id: `msg_${this.id}`, type: 'message', role: 'assistant', content: [], model: this.model, stop_reason: null, stop_sequence: null, usage: this.messagesUsage() } });
    else if (this.protocol === 'responses') { yield this.frame({ type: 'response.created', response: this.response('in_progress') }); yield this.frame({ type: 'response.in_progress', response: this.response('in_progress') }); }
  }
  *push(e: Event, stream: boolean): Generator<string> {
    if (e.kind === 'usage') { this.usage = e.usage; return; }
    if (e.kind === 'finish') { this.reason = e.reason; return; }
    if (e.kind === 'native') {
      this.bytes += Buffer.byteLength(JSON.stringify(e.value));
      if (this.bytes > MAX_RESPONSE) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
      if (this.nativeOutput && !this.blocks.some(b => b.key === e.key)) this.blocks.push({ key: e.key, type: 'reasoning', text: '', id: '', nativeId: '', name: '', index: this.blocks.length, toolIndex: 0, started: false });
      if (!this.nativeOutput && e.value.thoughtSignature && typeof e.value.text === 'string' && !e.value.thought) throw new RouterError('PROTOCOL_CONVERSION_UNSUPPORTED_SIGNED_TEXT', 422);
      const previous = this.nativeReasoning.get(e.key) ?? {};
      this.nativeReasoning.set(e.key, e.append ? { ...previous, ...Object.fromEntries(Object.entries(e.value).map(([k, v]) => [k, String(previous[k] ?? '') + String(v)])) } : e.value);
      return;
    }
    this.bytes += Buffer.byteLength(e.kind === 'tool' ? (e.args ?? '') + (e.id ?? '') + (e.name ?? '') : e.text);
    if (this.bytes > MAX_RESPONSE) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
    let b = this.blocks.find(b => b.key === e.key && b.type === e.kind);
    if (!b) { b = { key: e.key, type: e.kind, text: '', id: '', nativeId: '', name: '', index: this.blocks.length, toolIndex: this.blocks.filter(b => b.type === 'tool').length, started: false }; this.blocks.push(b); }
    const delta = e.kind === 'tool' ? e.args ?? '' : e.text;
    if (e.kind === 'tool' && e.snapshot) {
      if (b.name && e.name && b.name !== e.name) throw new RouterError('UPSTREAM_AMBIGUOUS_TOOL_CALL', 502);
      b.text = delta; b.name = e.name ?? b.name;
    } else { b.text += delta; if (e.kind === 'tool' && e.name) b.name += e.name; }
    if (e.kind === 'tool') {
      if (e.id) { b.nativeId = e.id; b.id ||= this.exchange?.reserve() ?? e.id; }
      if (e.native) { b.native = { ...b.native, ...e.native }; this.bytes += Buffer.byteLength(JSON.stringify(e.native)); if (this.bytes > MAX_RESPONSE) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502); }
    }
    // Gemini functionCall objects are snapshots. Publish each only after the
    // terminal frame, while text/reasoning continue to stream immediately.
    if (e.kind === 'tool' && e.snapshot) return;
    // Names and arguments may arrive in the same fragmented frames. Wait for
    // an unambiguous declared name before choosing its client-facing wire type.
    if (b.type === 'tool' && this.tools.size && !this.finishing
      && (!this.tools.has(b.name) || [...this.tools.keys()].some(name => name !== b.name && name.startsWith(b.name)))) return;
    // Custom tool input is a string inside upstream JSON. Publish it only once
    // complete, so escaped characters and fragmented surrogate pairs stay exact.
    if (b.type === 'tool' && (this.tools.get(b.name)?.custom || this.tools.get(b.name)?.search) && !this.finishing) return;
    if (this.protocol === 'gemini') {
      if (stream && b.type !== 'tool' && delta) yield this.frame({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: delta, ...(b.type === 'reasoning' ? { thought: true } : {}) }] } }] });
      return;
    }
    if (!stream || b.type === 'tool' && (!b.id || !b.name || !b.text)) return;
    yield* this.start();
    const fresh = !b.started;
    if (fresh) {
      b.started = true;
      if (this.protocol === 'messages') yield this.frame({ type: 'content_block_start', index: b.index, content_block: b.type === 'text' ? { type: 'text', text: '' } : b.type === 'reasoning' ? { type: 'thinking', thinking: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      else if (this.protocol === 'responses') {
        const item = this.item(b, false);
        yield this.frame({ type: 'response.output_item.added', output_index: b.index, item });
        if (b.type === 'text') yield this.frame({ type: 'response.content_part.added', item_id: item.id, output_index: b.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
        if (b.type === 'reasoning') yield this.frame({ type: 'response.reasoning_summary_part.added', item_id: item.id, output_index: b.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
    }
    const value = fresh ? b.text : delta;
    if (this.protocol === 'chat') {
      if (b.type === 'tool') yield this.frame(this.chat({ tool_calls: [{ index: b.toolIndex, ...(fresh ? { id: b.id, type: 'function' } : {}), function: { ...(fresh ? { name: b.name } : {}), arguments: value } }] }));
      else if (value) yield this.frame(this.chat({ [b.type === 'text' ? 'content' : 'reasoning_content']: value }));
    } else if (this.protocol === 'messages') {
      if (value) yield this.frame({ type: 'content_block_delta', index: b.index, delta: b.type === 'text' ? { type: 'text_delta', text: value } : b.type === 'reasoning' ? { type: 'thinking_delta', thinking: value } : { type: 'input_json_delta', partial_json: value } });
    } else if (value) {
      if (b.type === 'tool' && this.tools.get(b.name)?.search) return;
      const common = { item_id: this.item(b, false).id, output_index: b.index, delta: value };
      yield this.frame(b.type === 'tool' ? this.tools.get(b.name)?.custom ? { type: 'response.custom_tool_call_input.delta', ...common, delta: customToolInput(b.text) } : { type: 'response.function_call_arguments.delta', ...common } : b.type === 'text' ? { type: 'response.output_text.delta', ...common, content_index: 0, logprobs: [] } : { type: 'response.reasoning_summary_text.delta', ...common, summary_index: 0 });
    }
  }
  *finish(): Generator<string> {
    this.validateTools();
    this.finishing = true;
    this.completeState();
    if (this.protocol === 'gemini') {
      const parts = this.blocks.filter(b => b.type === 'tool').map(b => this.geminiPart(b));
      yield this.frame({ candidates: [{ index: 0, ...(parts.length ? { content: { role: 'model', parts } } : {}), finishReason: this.stopped() === 'length' ? 'MAX_TOKENS' : this.stopped() === 'content_filter' ? 'SAFETY' : 'STOP' }], usageMetadata: this.geminiUsage(), modelVersion: this.model }); return;
    }
    for (const b of this.blocks.filter(b => b.type === 'tool' && !b.started)) yield* this.push({ kind: 'tool', key: b.key, args: b.text ? '' : '{}' }, true);
    yield* this.start();
    if (this.protocol === 'chat') { yield this.frame(this.chat({}, this.stopped(), this.chatUsage())); yield 'data: [DONE]\n\n'; return; }
    for (const b of this.blocks) {
      if (this.protocol === 'messages') yield this.frame({ type: 'content_block_stop', index: b.index });
      else {
        const item = this.item(b, true); const common = { item_id: item.id, output_index: b.index };
        if (b.type === 'tool') { if (!this.tools.get(b.name)?.search) yield this.frame(this.tools.get(b.name)?.custom ? { type: 'response.custom_tool_call_input.done', ...common, input: customToolInput(b.text) } : { type: 'response.function_call_arguments.done', ...common, arguments: b.text || '{}', name: item.name }); }
        else if (b.type === 'text') { yield this.frame({ type: 'response.output_text.done', ...common, content_index: 0, text: b.text, logprobs: [] }); yield this.frame({ type: 'response.content_part.done', ...common, content_index: 0, part: item.content[0] }); }
        else { yield this.frame({ type: 'response.reasoning_summary_text.done', ...common, summary_index: 0, text: b.text }); yield this.frame({ type: 'response.reasoning_summary_part.done', ...common, summary_index: 0, part: item.summary[0] }); }
        yield this.frame({ type: 'response.output_item.done', output_index: b.index, item });
      }
    }
    if (this.protocol === 'messages') { yield this.frame({ type: 'message_delta', delta: { stop_reason: this.stopped() === 'length' ? 'max_tokens' : this.stopped() === 'tool_calls' ? 'tool_use' : this.stopped() === 'content_filter' ? 'refusal' : 'end_turn', stop_sequence: null }, usage: this.messagesUsage() }); yield this.frame({ type: 'message_stop' }); }
    else { const status = ['length', 'content_filter'].includes(this.stopped()) ? 'incomplete' : 'completed'; yield this.frame({ type: `response.${status}`, response: this.response(status) }); }
  }
}

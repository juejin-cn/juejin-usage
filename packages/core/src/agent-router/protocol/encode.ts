import { randomUUID } from 'node:crypto';
import { RouterError, type Protocol } from '../config.js';
import type { Event, Usage } from './events.js';
import type { Wire } from './request.js';
interface Block { key: string; type: 'text' | 'reasoning' | 'tool'; text: string; id: string; name: string; index: number; toolIndex: number; started: boolean }
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
  constructor(private protocol: Protocol, private model: string) {}
  private frame(value: Wire): string {
    if (this.protocol === 'responses') value.sequence_number = this.sequence++;
    return `${this.protocol === 'chat' ? '' : `event: ${value.type}\n`}data: ${JSON.stringify(value)}\n\n`;
  }
  private chat(delta: Wire, finish: string | null = null, usage?: Wire): Wire {
    return { id: `chatcmpl-${this.id}`, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
  }
  private chatUsage(): Wire { return { prompt_tokens: this.usage.input, completion_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output, prompt_tokens_details: { cached_tokens: this.usage.cached }, completion_tokens_details: { reasoning_tokens: this.usage.reasoning } }; }
  private messagesUsage(): Wire { return { input_tokens: Math.max(0, this.usage.input - this.usage.cached), output_tokens: this.usage.output, cache_read_input_tokens: this.usage.cached }; }
  private item(b: Block, done: boolean): Wire {
    if (b.type === 'tool') return { type: 'function_call', id: `fc_${this.id}_${b.index}`, call_id: b.id, name: b.name, arguments: done ? b.text || '{}' : '', status: done ? 'completed' : 'in_progress' };
    if (b.type === 'reasoning') return { type: 'reasoning', id: `rs_${this.id}_${b.index}`, summary: done ? [{ type: 'summary_text', text: b.text }] : [] };
    return { type: 'message', id: `msg_${this.id}_${b.index}`, status: done ? 'completed' : 'in_progress', role: 'assistant', content: done ? [{ type: 'output_text', text: b.text, annotations: [], logprobs: [] }] : [] };
  }
  private stopped(): string { return ['length', 'max_tokens'].includes(this.reason) ? 'length' : this.blocks.some(b => b.type === 'tool') ? 'tool_calls' : this.reason === 'content_filter' ? 'content_filter' : 'stop'; }
  private response(status: string): Wire {
    return { id: `resp_${this.id}`, object: 'response', created_at: this.created, status, error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      model: this.model, output: status === 'in_progress' ? [] : this.blocks.map(b => this.item(b, true)), parallel_tool_calls: true, tool_choice: 'auto', tools: [], store: false,
      usage: status === 'in_progress' ? null : { input_tokens: this.usage.input, output_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output, input_tokens_details: { cached_tokens: this.usage.cached }, output_tokens_details: { reasoning_tokens: this.usage.reasoning } } };
  }
  json(): Wire {
    this.validateTools();
    if (this.protocol === 'responses') return this.response(this.stopped() === 'length' ? 'incomplete' : 'completed');
    if (this.protocol === 'messages') return { id: `msg_${this.id}`, type: 'message', role: 'assistant', model: this.model,
      content: this.blocks.map(b => b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'reasoning' ? { type: 'thinking', thinking: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: JSON.parse(b.text || '{}') }),
      stop_reason: this.stopped() === 'length' ? 'max_tokens' : this.stopped() === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: this.messagesUsage() };
    const calls = this.blocks.filter(b => b.type === 'tool');
    const reasoning = this.blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('');
    return { id: `chatcmpl-${this.id}`, object: 'chat.completion', created: this.created, model: this.model, choices: [{ index: 0, message: { role: 'assistant', content: this.blocks.filter(b => b.type === 'text').map(b => b.text).join('') || null,
      ...(calls.length ? { tool_calls: calls.map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.text || '{}' } })) } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: this.stopped() }], usage: this.chatUsage() };
  }
  private validateTools(): void {
    for (const b of this.blocks.filter(b => b.type === 'tool')) {
      if (!b.id || !b.name) throw new RouterError('UPSTREAM_INVALID_TOOL_CALL', 502);
      try { const input = JSON.parse(b.text || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); } catch { throw new RouterError('UPSTREAM_INVALID_TOOL_ARGUMENTS', 502); }
    }
  }
  private *start(): Generator<string> {
    if (this.started) return; this.started = true;
    if (this.protocol === 'chat') yield this.frame(this.chat({ role: 'assistant', content: '' }));
    else if (this.protocol === 'messages') yield this.frame({ type: 'message_start', message: { id: `msg_${this.id}`, type: 'message', role: 'assistant', content: [], model: this.model, stop_reason: null, stop_sequence: null, usage: this.messagesUsage() } });
    else { yield this.frame({ type: 'response.created', response: this.response('in_progress') }); yield this.frame({ type: 'response.in_progress', response: this.response('in_progress') }); }
  }
  *push(e: Event, stream: boolean): Generator<string> {
    if (e.kind === 'usage') { this.usage = e.usage; return; }
    if (e.kind === 'finish') { this.reason = e.reason; return; }
    this.bytes += Buffer.byteLength(e.kind === 'tool' ? (e.args ?? '') + (e.id ?? '') + (e.name ?? '') : e.text);
    if (this.bytes > MAX_RESPONSE) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
    let b = this.blocks.find(b => b.key === e.key && b.type === e.kind);
    if (!b) { b = { key: e.key, type: e.kind, text: '', id: '', name: '', index: this.blocks.length, toolIndex: this.blocks.filter(b => b.type === 'tool').length, started: false }; this.blocks.push(b); }
    const delta = e.kind === 'tool' ? e.args ?? '' : e.text;
    b.text += delta;
    if (e.kind === 'tool') { if (e.id) b.id = e.id; if (e.name) b.name += e.name; }
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
      const common = { item_id: this.item(b, false).id, output_index: b.index, delta: value };
      yield this.frame(b.type === 'tool' ? { type: 'response.function_call_arguments.delta', ...common } : b.type === 'text' ? { type: 'response.output_text.delta', ...common, content_index: 0, logprobs: [] } : { type: 'response.reasoning_summary_text.delta', ...common, summary_index: 0 });
    }
  }
  *finish(): Generator<string> {
    this.validateTools();
    for (const b of this.blocks.filter(b => b.type === 'tool' && !b.started)) yield* this.push({ kind: 'tool', key: b.key, args: b.text ? '' : '{}' }, true);
    yield* this.start();
    if (this.protocol === 'chat') { yield this.frame(this.chat({}, this.stopped(), this.chatUsage())); yield 'data: [DONE]\n\n'; return; }
    for (const b of this.blocks) {
      if (this.protocol === 'messages') yield this.frame({ type: 'content_block_stop', index: b.index });
      else {
        const item = this.item(b, true); const common = { item_id: item.id, output_index: b.index };
        if (b.type === 'tool') yield this.frame({ type: 'response.function_call_arguments.done', ...common, arguments: b.text || '{}', name: b.name });
        else if (b.type === 'text') { yield this.frame({ type: 'response.output_text.done', ...common, content_index: 0, text: b.text, logprobs: [] }); yield this.frame({ type: 'response.content_part.done', ...common, content_index: 0, part: item.content[0] }); }
        else { yield this.frame({ type: 'response.reasoning_summary_text.done', ...common, summary_index: 0, text: b.text }); yield this.frame({ type: 'response.reasoning_summary_part.done', ...common, summary_index: 0, part: item.summary[0] }); }
        yield this.frame({ type: 'response.output_item.done', output_index: b.index, item });
      }
    }
    if (this.protocol === 'messages') { yield this.frame({ type: 'message_delta', delta: { stop_reason: this.stopped() === 'length' ? 'max_tokens' : this.stopped() === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: this.messagesUsage() }); yield this.frame({ type: 'message_stop' }); }
    else { const status = this.stopped() === 'length' ? 'incomplete' : 'completed'; yield this.frame({ type: `response.${status}`, response: this.response(status) }); }
  }
}

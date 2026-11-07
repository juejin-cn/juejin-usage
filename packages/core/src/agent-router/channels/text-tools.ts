import { ChannelError, type Json } from './http.js';
/** Decode model-emitted calls only for tools explicitly offered by the caller. */
export class TextToolDecoder {
  private pending = '';
  private quoted = false;
  constructor(private readonly tools: Json[]) {}
  feed(text: string, end = false): Array<{ text?: string; name?: string; arguments?: string }> {
    this.pending += text;
    if (this.pending.length > 1024 * 1024) throw new ChannelError(502, 'SUBSCRIPTION_TOOL_TOO_LARGE');
    const output: Array<{ text?: string; name?: string; arguments?: string }> = [];
    const emit = (s: string) => { if (s) { output.push({ text: s }); for (const _ of s.matchAll(/`/g)) this.quoted = !this.quoted; } };
    while (this.pending) {
      const at = this.pending.indexOf('<');
      if (at < 0) { emit(this.pending); this.pending = ''; break; }
      emit(this.pending.slice(0, at)); this.pending = this.pending.slice(at);
      if (this.quoted) { emit('<'); this.pending = this.pending.slice(1); continue; }
      const start = /^<(?:tool_call|function=([^<>\s]+)|(?:antml:)?invoke\s+name="([^"<>]+)")>/.exec(this.pending);
      if (!start) {
        const wrapper = /^<\/?(?:antml:)?function_calls>/.exec(this.pending);
        if (wrapper) { this.pending = this.pending.slice(wrapper[0].length); continue; }
        if (!end && !this.pending.includes('>') && this.pending.length < 512) break;
        emit('<'); this.pending = this.pending.slice(1); continue;
      }
      const name = start[1] || start[2];
      const close = start[1] ? '</function>' : start[2] ? start[0].startsWith('<antml:') ? '</antml:invoke>' : '</invoke>' : '</tool_call>';
      const stop = this.pending.indexOf(close, start[0].length);
      if (stop < 0) { if (end) throw new ChannelError(502, 'SUBSCRIPTION_TRUNCATED_TOOL'); break; }
      const raw = this.pending.slice(start[0].length, stop); const whole = this.pending.slice(0, stop + close.length); this.pending = this.pending.slice(stop + close.length);
      let toolName = name; let args: Json = Object.create(null);
      if (!name) {
        try { const call = JSON.parse(raw); toolName = call.name; args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; }
        catch { throw new ChannelError(502, 'SUBSCRIPTION_INVALID_TOOL'); }
      } else {
        const tool = this.tools.find(t => (t.function || t).name === name); const props = (tool?.function || tool)?.parameters?.properties || {};
        const pattern = /<(?:antml:)?parameter(?:=([^<>\s]+)|\s+name="([^"<>]+)")>([\s\S]*?)<\/(?:antml:)?parameter>/g;
        let remaining = raw;
        for (const match of raw.matchAll(pattern)) {
          const key = match[1] || match[2]; let value: any = match[3];
          if (props[key]?.type !== 'string') { try { value = JSON.parse(value); } catch { if (props[key]?.type && props[key].type !== 'string') throw new ChannelError(502, 'SUBSCRIPTION_INVALID_TOOL'); } }
          args[key] = value; remaining = remaining.replace(match[0], '');
        }
        if (remaining.trim()) throw new ChannelError(502, 'SUBSCRIPTION_INVALID_TOOL');
      }
      if (!this.tools.some(t => (t.function || t).name === toolName)) { emit(whole); continue; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ChannelError(502, 'SUBSCRIPTION_INVALID_TOOL');
      output.push({ name: toolName, arguments: JSON.stringify(args) });
    }
    return output;
  }
}

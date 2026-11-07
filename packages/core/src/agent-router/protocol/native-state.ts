import { createHash, randomUUID } from 'node:crypto';
import { RouterError, type Protocol } from '../config.js';
import type { Wire } from './request.js';

const PREFIX = 'call_jusage_';
export function hasNativeReferences(body: Wire, protocol: Protocol): boolean {
  const list = (v: unknown): Wire[] => Array.isArray(v) ? v : [];
  const managed = (id: unknown) => typeof id === 'string' && id.startsWith(PREFIX);
  if (protocol === 'chat') return list(body.messages).some(m => managed(m.tool_call_id) || list(m.tool_calls).some(c => managed(c.id)));
  if (protocol === 'messages') return list(body.messages).some(m => list(m.content).some(p => p.type === 'tool_use' && managed(p.id) || p.type === 'tool_result' && managed(p.tool_use_id)));
  if (protocol === 'responses') return list(body.input).some(p => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output'].includes(p.type) && managed(p.call_id));
  return list(body.contents).some(c => list(c.parts).some(p => managed(p.functionCall?.id) || managed(p.functionResponse?.id)));
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)]));
  return v;
}
const digest = (args: string) => {
  try { return createHash('sha256').update(JSON.stringify(canonical(JSON.parse(args || '{}')))).digest('hex'); }
  catch { throw new RouterError('INVALID_TOOL_ARGUMENTS', 400); }
};
interface SavedCall { origin: string; protocol: Protocol; nativeId: string; name: string; digest: string; metadata?: Wire; reasoning: Wire[]; batch: string; expires: number; bytes: number }
export interface NativeCall { id: string; nativeId: string; name: string; args: string; metadata?: Wire }
/** Conversation state stays in bounded memory, never in traces or client call IDs. */
export class NativeStateStore {
  private entries = new Map<string, SavedCall>();
  private bytes = 0;
  constructor(private now = Date.now, private ttl = 30 * 60_000, private capacity = 1024, private maxBytes = 16 * 1024 * 1024) {}
  clear(): void { this.entries.clear(); this.bytes = 0; }
  private prune() {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) { this.entries.delete(id); this.bytes -= entry.bytes; }
  }
  exchange(origin: string, protocol: Protocol): NativeExchange { return new NativeExchange(this, origin, protocol); }
  save(origin: string, protocol: Protocol, calls: NativeCall[], reasoning: Wire[]): void {
    this.prune();
    const batch = randomUUID(); const next = calls.map(call => {
      const data = { origin, protocol, nativeId: call.nativeId, name: call.name, digest: digest(call.args), metadata: call.metadata, reasoning, batch, expires: this.now() + this.ttl };
      return [call.id, { ...data, bytes: Buffer.byteLength(JSON.stringify(data)) }] as const;
    });
    const bytes = next.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    if (next.length > this.capacity || bytes > this.maxBytes) throw new RouterError('NATIVE_STATE_CAPACITY', 503);
    while (this.entries.size + next.length > this.capacity || this.bytes + bytes > this.maxBytes) {
      const [id, entry] = this.entries.entries().next().value!; this.entries.delete(id); this.bytes -= entry.bytes;
    }
    for (const [id, entry] of next) { const old = this.entries.get(id); if (old) this.bytes -= old.bytes; this.entries.set(id, entry); this.bytes += entry.bytes; }
  }
  get(id: string, origin: string): SavedCall {
    this.prune(); const entry = this.entries.get(id);
    if (!entry) throw new RouterError('NATIVE_STATE_EXPIRED_RESTART_SESSION', 409);
    if (entry.origin !== origin) throw new RouterError('NATIVE_STATE_ORIGIN_MISMATCH', 409);
    return entry;
  }
}
export class NativeExchange {
  constructor(private store: NativeStateStore, private origin: string, readonly protocol: Protocol) {}
  reserve(): string { return PREFIX + randomUUID().replaceAll('-', ''); }
  complete(calls: NativeCall[], reasoning: Wire[]): void {
    if (reasoning.length && !calls.length) throw new RouterError('NATIVE_STATE_REQUIRES_TOOL_CALL', 422);
    this.store.save(this.origin, this.protocol, calls, reasoning);
  }
  restore(chat: Wire): Wire {
    const seen = new Set<string>(); const restored = new Set<string>();
    for (const message of chat.messages ?? []) {
      for (const call of message.tool_calls ?? []) {
        if (!String(call.id).startsWith(PREFIX)) continue;
        const clientId = call.id; const entry = this.store.get(clientId, this.origin);
        if (entry.protocol !== this.protocol || entry.name !== call.function?.name || entry.digest !== digest(call.function?.arguments)) throw new RouterError('NATIVE_STATE_CALL_MISMATCH', 409);
        seen.add(clientId); call.id = entry.nativeId;
        Object.assign(call, structuredClone(entry.metadata ?? {}));
        if (!restored.has(entry.batch)) {
          message.native_reasoning = [...(message.native_reasoning ?? []), ...structuredClone(entry.reasoning)]; restored.add(entry.batch);
        }
      }
      if (message.role === 'tool' && String(message.tool_call_id).startsWith(PREFIX)) {
        const id = message.tool_call_id; const entry = this.store.get(id, this.origin);
        if (!seen.has(id)) throw new RouterError('NATIVE_STATE_CALL_HISTORY_REQUIRED', 409);
        message.tool_call_id = entry.nativeId;
      }
    }
    return chat;
  }
}

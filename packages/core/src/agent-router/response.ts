import { Readable } from 'node:stream';
import { AttemptFailure, responseFailure } from './routing.js';
import type { TransportReply } from './transport.js';

const PREFIX_LIMIT = 256 * 1024;
function sseFailure(value: Record<string, unknown>): AttemptFailure | null {
  if (!value.error && value.type !== 'error' && value.type !== 'response.failed') return null;
  const error = (value.error ?? (value.response as { error?: unknown } | undefined)?.error ?? {}) as Record<string, unknown>;
  const status = Number(error.status ?? error.status_code ?? error.code);
  const code = String(error.type ?? error.code ?? '');
  const mapped = status >= 400 && status <= 599 ? status : /rate_limit|quota/.test(code) ? 429 : /authentication|invalid_api_key/.test(code) ? 401 : /invalid_request/.test(code) ? 400 : /overloaded/.test(code) ? 503 : 502;
  return responseFailure(mapped);
}
/** A bounded framing probe, not a protocol translator. Never stores frame content in a trace. */
class SseProbe {
  private decoder = new TextDecoder();
  private pending = '';
  content = false;
  terminal = false;
  push(chunk: Buffer): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending); if (!boundary) break;
      const frame = this.pending.slice(0, boundary.index); this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { this.terminal = true; continue; }
      let value: Record<string, unknown>;
      try { value = JSON.parse(data); } catch { this.content = true; continue; }
      if (!value || typeof value !== 'object') { this.content = true; continue; }
      const failure = sseFailure(value); if (failure) throw failure;
      const choices = Array.isArray(value.choices) ? value.choices as Array<Record<string, unknown>> : [];
      const hasText = (v: unknown) => typeof v === 'string' && v.length > 0 || Array.isArray(v) && v.length > 0;
      for (const choice of choices) {
        const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
        if (hasText(delta.content) || hasText(delta.reasoning_content) || hasText(delta.tool_calls) || delta.function_call) this.content = true;
        if (choice.finish_reason) this.terminal = true;
      }
      const delta = value.delta as Record<string, unknown> | string | undefined;
      if (typeof delta === 'object' && delta && (hasText(delta.text) || hasText(delta.thinking) || hasText(delta.partial_json))) this.content = true;
      if (typeof delta === 'string' && delta.length && /^response\..*\.delta$/.test(String(value.type))) this.content = true;
      const block = (value.content_block ?? value.item) as Record<string, unknown> | undefined;
      if (block && (hasText(block.text) || ['tool_use', 'function_call'].includes(String(block.type)))) this.content = true;
      if (['message_stop', 'response.completed', 'response.incomplete'].includes(String(value.type))) this.terminal = true;
    }
    if (this.pending.length > PREFIX_LIMIT) throw new AttemptFailure('UPSTREAM_FRAME_TOO_LARGE', 502, 'unavailable', true);
  }
}
function nextPart(iterator: AsyncIterator<Buffer>, signal: AbortSignal, idleMs: number): Promise<IteratorResult<Buffer>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { clean(); reject(signal.reason); };
    const timer = setTimeout(() => { clean(); reject(new AttemptFailure('UPSTREAM_IDLE_TIMEOUT', 504, 'unavailable', true)); }, idleMs); timer.unref();
    signal.addEventListener('abort', cancel, { once: true });
    void iterator.next().then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
  });
}
/** Hold only until semantic SSE content (or a valid terminal event), then relay raw bytes. */
export async function prepareReply(reply: TransportReply, signal: AbortSignal, idleMs = 30000): Promise<Readable> {
  const iterator = reply.body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const probe = reply.headers['content-type'].includes('text/event-stream') && !reply.headers['content-encoding'] ? new SseProbe() : null;
  const prefix: Buffer[] = []; let size = 0; let ended = false;
  do {
    const part = await nextPart(iterator, signal, idleMs);
    if (part.done) { ended = true; break; }
    const chunk = Buffer.from(part.value); size += chunk.length;
    if (probe && size > PREFIX_LIMIT) throw new AttemptFailure('UPSTREAM_PREFIX_TOO_LARGE', 502, 'unavailable', true);
    prefix.push(chunk); probe?.push(chunk);
  } while (probe && !probe.content && !probe.terminal);
  if (probe && ended && !probe.content && !probe.terminal) throw new AttemptFailure('UPSTREAM_EMPTY_STREAM', 502, 'unavailable', true);
  return Readable.from((async function* () {
    yield* prefix;
    if (ended) return;
    for (;;) {
      const part = await nextPart(iterator, signal, idleMs); if (part.done) break;
      const chunk = Buffer.from(part.value); probe?.push(chunk); yield chunk;
    }
  })());
}

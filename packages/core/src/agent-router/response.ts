import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Protocol } from './config.js';
import { AttemptFailure, responseFailure } from './routing.js';
import type { TransportReply } from './transport.js';

const PREFIX_LIMIT = 256 * 1024;
const FRAME_LIMIT = 1024 * 1024;
function sseFailure(value: Record<string, unknown>): AttemptFailure | null {
  const nested = (value.response as { error?: unknown } | undefined)?.error;
  if (!value.error && !nested && value.type !== 'error' && value.type !== 'response.failed') return null;
  const error = (value.error ?? nested ?? {}) as Record<string, unknown>;
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
  constructor(private protocol?: Protocol) {}
  push(chunk: Buffer): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending); if (!boundary) break;
      if (boundary.index > FRAME_LIMIT) throw new AttemptFailure('UPSTREAM_FRAME_TOO_LARGE', 502, 'unavailable', true);
      const frame = this.pending.slice(0, boundary.index); this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { if (!this.protocol || this.protocol === 'chat') this.terminal = true; continue; }
      let value: Record<string, unknown>;
      try { value = JSON.parse(data); } catch { throw new AttemptFailure('UPSTREAM_INVALID_SSE', 502, 'unavailable', true); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AttemptFailure('UPSTREAM_INVALID_SSE', 502, 'unavailable', true);
      const failure = sseFailure(value); if (failure) throw failure;
      const choices = Array.isArray(value.choices) ? value.choices as Array<Record<string, unknown>> : [];
      const hasText = (v: unknown) => typeof v === 'string' && v.length > 0 || Array.isArray(v) && v.length > 0;
      for (const choice of choices) {
        const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
        if (hasText(delta.content) || hasText(delta.reasoning_content) || hasText(delta.tool_calls) || delta.function_call) this.content = true;
        if (choice.finish_reason && (!this.protocol || this.protocol === 'chat')) this.terminal = true;
      }
      const candidates = Array.isArray(value.candidates) ? value.candidates as Array<Record<string, unknown>> : [];
      if ((!this.protocol || this.protocol === 'gemini') && (value.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason) this.terminal = true;
      for (const candidate of candidates) {
        const parts = (candidate.content as { parts?: unknown } | undefined)?.parts;
        if (Array.isArray(parts)) for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          if (hasText(part.text) || typeof part.functionCall?.name === 'string' && part.functionCall.name.length
            || typeof part.inlineData?.data === 'string' && part.inlineData.data.length) this.content = true;
        }
        if (typeof candidate.finishReason === 'string' && candidate.finishReason.length && (!this.protocol || this.protocol === 'gemini')) this.terminal = true;
      }
      const delta = value.delta as Record<string, unknown> | string | undefined;
      if (typeof delta === 'object' && delta && (hasText(delta.text) || hasText(delta.thinking) || hasText(delta.partial_json))) this.content = true;
      if (typeof delta === 'string' && delta.length && /^response\..*\.delta$/.test(String(value.type))) this.content = true;
      const block = (value.content_block ?? value.item) as Record<string, unknown> | undefined;
      if (block && (hasText(block.text) || hasText(block.thinking) || hasText(block.encrypted_content) || typeof block.type === 'string' && !['message', 'reasoning', 'text', 'thinking'].includes(block.type))) this.content = true;
      if ((!this.protocol || this.protocol === 'messages') && value.type === 'message_stop'
        || (!this.protocol || this.protocol === 'responses') && ['response.completed', 'response.incomplete'].includes(String(value.type))) this.terminal = true;
    }
    if (this.pending.length > FRAME_LIMIT) throw new AttemptFailure('UPSTREAM_FRAME_TOO_LARGE', 502, 'unavailable', true);
  }
  finish(): void {
    this.pending += this.decoder.decode();
    if (this.pending.trim()) this.push(Buffer.from('\n\n'));
    if (this.protocol && this.content && !this.terminal) throw new AttemptFailure('UPSTREAM_TRUNCATED_STREAM', 502, 'unavailable', true);
  }
}

/** Decode transfer compression before semantic inspection; protocol payload bytes
 * remain unchanged and the obsolete content-encoding header is removed. */
export function decompressReply(reply: TransportReply): TransportReply {
  const encoding = reply.headers['content-encoding']?.toLowerCase();
  if (!encoding || encoding === 'identity') return reply;
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
  if (!decoder) throw new AttemptFailure('UPSTREAM_UNSUPPORTED_ENCODING', 502, 'unavailable', false);
  reply.body.once('error', error => decoder.destroy(error));
  const body = reply.body.pipe(decoder), headers = { ...reply.headers }; delete headers['content-encoding'];
  return { status: reply.status, headers, body, dispose() { body.destroy(); reply.dispose(); } };
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
export async function prepareReply(reply: TransportReply, signal: AbortSignal, idleMs = 30000, protocol?: Protocol): Promise<Readable> {
  const iterator = reply.body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const encoding = reply.headers['content-encoding']?.toLowerCase();
  const probe = reply.headers['content-type'].toLowerCase().includes('text/event-stream') && (!encoding || encoding === 'identity') ? new SseProbe(protocol) : null;
  const prefix: Buffer[] = []; let size = 0; let ended = false;
  do {
    const part = await nextPart(iterator, signal, idleMs);
    if (part.done) { ended = true; break; }
    const chunk = Buffer.from(part.value); size += chunk.length;
    if (probe && size > PREFIX_LIMIT) throw new AttemptFailure('UPSTREAM_PREFIX_TOO_LARGE', 502, 'unavailable', true);
    prefix.push(chunk); probe?.push(chunk);
  } while (probe && !probe.content && !probe.terminal);
  if (ended) probe?.finish();
  if (probe && ended && !probe.content && !probe.terminal) throw new AttemptFailure('UPSTREAM_EMPTY_STREAM', 502, 'unavailable', true);
  return Readable.from((async function* () {
    yield* prefix;
    if (ended) return;
    for (;;) {
      const part = await nextPart(iterator, signal, idleMs); if (part.done) break;
      const chunk = Buffer.from(part.value); probe?.push(chunk); yield chunk;
    }
    probe?.finish();
  })());
}

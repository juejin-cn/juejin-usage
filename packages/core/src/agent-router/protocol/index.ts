import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { RouterError, type Protocol } from '../config.js';
import type { TransportReply } from '../transport.js';
import { EventDecoder, jsonEvents, type Event } from './events.js';
import { EventEncoder } from './encode.js';
import type { Wire } from './request.js';
export { convertRequest } from './request.js';
export function canConvertProtocol(from: Protocol, to: Protocol): boolean { return ['chat', 'responses', 'messages'].includes(from) && ['chat', 'responses', 'messages'].includes(to); }

async function* events(body: Readable, type: string, protocol: Protocol, signal: AbortSignal): AsyncGenerator<Event> {
  const decoder = new TextDecoder(); let pending = ''; let total = 0;
  const sse = type.includes('text/event-stream'); const state = new EventDecoder();
  const frame = function* (raw: string): Generator<Event> {
    const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { if (protocol === 'chat') state.terminal = true; return; }
    let value: Wire; try { value = JSON.parse(data); } catch { throw new RouterError('UPSTREAM_INVALID_SSE', 502); }
    if (!value || typeof value !== 'object') throw new RouterError('UPSTREAM_INVALID_SSE', 502);
    yield* state.push(value, protocol);
  };
  for await (const chunk of body) {
    if (signal.aborted) throw signal.reason;
    total += Buffer.byteLength(chunk);
    if (total > 32 * 1024 * 1024) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
    pending += decoder.decode(Buffer.from(chunk), { stream: true });
    if (sse) {
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(pending); if (!boundary) break;
        if (boundary.index > 1024 * 1024) throw new RouterError('UPSTREAM_FRAME_TOO_LARGE', 502);
        yield* frame(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (pending.length > 1024 * 1024) throw new RouterError('UPSTREAM_FRAME_TOO_LARGE', 502);
    }
  }
  pending += decoder.decode();
  if (signal.aborted) throw signal.reason;
  if (sse) { if (pending.trim()) yield* frame(pending); if (!state.terminal) throw new RouterError('UPSTREAM_TRUNCATED_STREAM', 502); }
  else {
    let value: Wire; try { value = JSON.parse(pending); } catch { throw new RouterError('UPSTREAM_INVALID_JSON', 502); }
    if (!value || typeof value !== 'object') throw new RouterError('UPSTREAM_INVALID_JSON', 502);
    yield* jsonEvents(value, protocol);
  }
}
/** Bounded, pull-based conversion: stream backpressure and abort flow to the original transport. */
export function convertReply(reply: TransportReply, source: Protocol, target: Protocol, model: string, streaming: boolean, signal: AbortSignal): TransportReply {
  const gather = !streaming && (reply.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream');
  if (source === target && !gather) return reply;
  let input = reply.body;
  const compression = reply.headers['content-encoding']?.toLowerCase();
  if (compression && compression !== 'identity') {
    const unzip = compression === 'gzip' ? createGunzip() : compression === 'deflate' ? createInflate() : compression === 'br' ? createBrotliDecompress() : null;
    if (!unzip) throw new RouterError('UPSTREAM_UNSUPPORTED_ENCODING', 502);
    reply.body.once('error', error => unzip.destroy(error)); input = reply.body.pipe(unzip);
  }
  const encoder = new EventEncoder(target, model);
  const converted = Readable.from((async function* () {
    try {
      for await (const event of events(input, reply.headers['content-type'] ?? '', source, signal)) yield* encoder.push(event, streaming);
      if (streaming) yield* encoder.finish(); else yield JSON.stringify(encoder.json());
    } finally { input.destroy(); reply.dispose(); }
  })());
  // Register immediately, including before a consumer starts reading.
  const abort = () => { input.destroy(); converted.destroy(signal.reason instanceof Error ? signal.reason : new Error('REQUEST_CANCELLED')); reply.dispose(); };
  signal.addEventListener('abort', abort, { once: true });
  converted.once('close', () => { signal.removeEventListener('abort', abort); input.destroy(); reply.dispose(); });
  if (signal.aborted) abort();
  return { status: reply.status, headers: { 'content-type': streaming ? 'text/event-stream; charset=utf-8' : 'application/json' }, body: converted, dispose() { converted.destroy(); input.destroy(); reply.dispose(); } };
}

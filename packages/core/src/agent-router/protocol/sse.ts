import type { Readable } from 'node:stream';
import { RouterError } from '../config.js';
import type { Wire } from './request.js';

export interface WireFrame { raw: string; value?: Wire }
/** Preserve unknown native frames while bounding decompressed input and each frame. */
export async function* wireFrames(body: Readable, signal: AbortSignal): AsyncGenerator<WireFrame> {
  const decoder = new TextDecoder(); let pending = '', bytes = 0;
  const parse = (raw: string): WireFrame => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return { raw };
    let value: unknown; try { value = JSON.parse(data); } catch { throw new RouterError('UPSTREAM_INVALID_SSE', 502); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouterError('UPSTREAM_INVALID_SSE', 502);
    return { raw, value: value as Wire };
  };
  for await (const chunk of body) {
    if (signal.aborted) throw signal.reason;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 32 * 1024 * 1024) throw new RouterError('UPSTREAM_RESPONSE_TOO_LARGE', 502);
    pending += decoder.decode(Buffer.from(chunk), { stream: true });
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(pending); if (!boundary) break;
      if (boundary.index > 1024 * 1024) throw new RouterError('UPSTREAM_FRAME_TOO_LARGE', 502);
      const end = boundary.index + boundary[0].length;
      yield parse(pending.slice(0, end)); pending = pending.slice(end);
    }
    if (pending.length > 1024 * 1024) throw new RouterError('UPSTREAM_FRAME_TOO_LARGE', 502);
  }
  pending += decoder.decode();
  if (signal.aborted) throw signal.reason;
  if (pending.trim()) yield parse(pending);
}

import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import type { RouterProvider } from './config.js';

export function nativeAuthHeaders(provider: RouterProvider, key: string): Record<string, string> {
  if (provider.protocol === 'gemini' && provider.auth.kind !== 'oauth') return { 'x-goog-api-key': key };
  if (provider.protocol !== 'messages') return { authorization: `Bearer ${key}` };
  const bearer = provider.auth.kind === 'oauth' || provider.preset?.startsWith('glm-');
  return { 'anthropic-version': '2023-06-01', [bearer ? 'authorization' : 'x-api-key']: bearer ? `Bearer ${key}` : key };
}

export function glmErrorStatus(value: unknown): number | null {
  if (!value || typeof value !== 'object' || (value as { success?: unknown }).success !== false) return null;
  const code = Number((value as { code?: unknown }).code);
  if (code >= 1000 && code <= 1005) return 401;
  if (code === 1113 || (code >= 1302 && code <= 1399)) return 429;
  if (code === 1220) return 403;
  if ((code >= 1210 && code <= 1229) || code === 1261 || code === 1301) return 400;
  return 502;
}
/** GLM's Responses endpoint can report a vendor refusal as HTTP 200.
 * Inspect only small JSON responses; preserve large replies and SSE as streams. */
export async function normalizeGlmReply(upstream: IncomingMessage): Promise<{ status: number; stream: Readable }> {
  const status = upstream.statusCode ?? 502;
  if (status !== 200 || !upstream.headers['content-type']?.includes('application/json') || upstream.headers['content-encoding']) return { status, stream: upstream };
  const iterator = upstream.iterator({ destroyOnReturn: false });
  const chunks: Buffer[] = []; let size = 0; let complete = false;
  while (size <= 65536) {
    const part = await iterator.next(); if (part.done) { complete = true; break; }
    const chunk = Buffer.from(part.value); chunks.push(chunk); size += chunk.length;
  }
  if (complete) {
    try {
      const error = glmErrorStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (error) { upstream.destroy(); return { status: error, stream: Readable.from([]) }; }
    } catch { /* A native non-envelope response passes unchanged. */ }
  }
  return { status, stream: Readable.from((async function* () { yield* chunks; for await (const part of iterator) yield part; })()) };
}

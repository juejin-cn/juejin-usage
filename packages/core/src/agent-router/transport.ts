import { currentRequestRecording } from './request-archive.js';
import { geminiDestination } from './gemini-route.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { RouterCredentials } from './auth.js';
import { RouterError, type RouterProvider } from './config.js';
import { nativeAuthHeaders, normalizeGlmReply } from './glm.js';
import { FAILURE_HEADER, failureHeaders } from './failure-codes.js';

export interface TransportReply { status: number; headers: Record<string, string>; body: Readable; dispose(): void }
const suffixes = { chat: 'chat/completions', responses: 'responses', messages: 'messages' };
/** Both transports have the same lifetime: caller owns the signal and disposal. */
export async function openTransport(credentials: RouterCredentials, provider: RouterProvider, body: Record<string, unknown>, signal: AbortSignal, port: number, session?: string, fallback = false, features: Record<string, string> = {}, count = false): Promise<TransportReply> {
  const send = () => performTransport(credentials, provider, body, signal, port, session, fallback, features, count);
  const recording = currentRequestRecording();
  return recording ? recording.send(provider, body, provider.auth.kind === 'subscription' ? `subscription:${provider.auth.provider}` : provider.protocol === 'gemini' ? geminiDestination(provider.baseUrl, String(body.model), count ? 'countTokens' : body.stream === true ? 'streamGenerateContent' : 'generateContent').pathname : new URL(`${provider.baseUrl}/${suffixes[provider.protocol]}${count ? '/count_tokens' : ''}`).pathname, send, features) : send();
}

async function performTransport(credentials: RouterCredentials, provider: RouterProvider, body: Record<string, unknown>, signal: AbortSignal, port: number, session?: string, fallback = false, features: Record<string, string> = {}, count = false): Promise<TransportReply> {
  if (count && (provider.auth.kind === 'subscription' || !['messages', 'gemini'].includes(provider.protocol))) throw new RouterError('TOKEN_COUNT_UNSUPPORTED', 422);
  if (provider.auth.kind === 'subscription') {
    const response = await credentials.subscriptions.fetch(provider, body, signal, session, fallback, features);
    const stream = response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : Readable.from([]);
    return { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json', ...Object.fromEntries(['request-id', 'x-request-id'].flatMap(key => response.headers.has(key) ? [[key, response.headers.get(key)!]] : [])), ...failureHeaders(response.headers.get(FAILURE_HEADER), response.status), ...(response.headers.get('retry-after') ? { 'retry-after': response.headers.get('retry-after')! } : {}) }, body: stream, dispose: () => { stream.destroy(); } };
  }
  const key = await credentials.resolve(provider); currentRequestRecording()?.secret(key);
  const destination = provider.protocol === 'gemini' ? geminiDestination(provider.baseUrl, String(body.model), count ? 'countTokens' : body.stream === true ? 'streamGenerateContent' : 'generateContent') : new URL(`${provider.baseUrl}/${suffixes[provider.protocol]}${count ? '/count_tokens' : ''}`);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname) && Number(destination.port) === port) throw new RouterError('GATEWAY_LOOP');
  const payload = { ...body };
  if (provider.protocol === 'gemini') {
    delete payload.model; delete payload.stream;
    if (count && payload.generateContentRequest && typeof payload.generateContentRequest === 'object' && !Array.isArray(payload.generateContentRequest)) payload.generateContentRequest = { ...payload.generateContentRequest, model: `models/${String(body.model)}` };
  }
  const raw = Buffer.from(JSON.stringify(payload));
  const upstream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'content-length': raw.length, accept: 'application/json, text/event-stream', ...nativeAuthHeaders(provider, key), ...features },
    }, resolve);
    request.on('error', reject); request.end(raw);
  });
  try {
    const normalized = provider.preset?.startsWith('glm-') ? await normalizeGlmReply(upstream) : { status: upstream.statusCode ?? 502, stream: upstream };
    const headers: Record<string, string> = { 'content-type': upstream.headers['content-type'] ?? 'application/json' };
    for (const key of ['content-encoding', 'retry-after', 'request-id', 'x-request-id']) { const value = upstream.headers[key]; if (typeof value === 'string') headers[key] = value; }
    return { status: normalized.status, headers, body: normalized.stream, dispose: () => { normalized.stream.destroy(); upstream.destroy(); } };
  } catch (error) { upstream.destroy(); throw error; }
}

import { setTimeout as delay } from 'node:timers/promises';
import type { SubscriptionAuth, SubscriptionModel } from '../subscription-types.js';
export type Json = Record<string, any>;
export class ChannelError extends Error {
  readonly signIn?: 'expired';
  constructor(public readonly status: number, code = 'SUBSCRIPTION_UPSTREAM_FAILED') {
    super(status === 401 ? 'SUBSCRIPTION_LOGIN_REQUIRED' : code);
    if (status === 401) this.signIn = 'expired';
  }
}
export function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelError(502, 'SUBSCRIPTION_INVALID_RESPONSE');
  return value as Json;
}
export function token(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || /[\r\n\x00]/.test(value)) throw new ChannelError(502, 'SUBSCRIPTION_INVALID_RESPONSE');
  return value;
}
export function jwt(value: unknown): Json { try { return record(JSON.parse(Buffer.from(String(value).split('.')[1], 'base64url').toString())); } catch { return {}; } }
export function expires(value: unknown, fallback = Date.now() + 3600_000): number {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return fallback;
}
export function oauth(data: Json, previous: SubscriptionAuth = {}): SubscriptionAuth {
  const access = token(data.access_token); const claims = jwt(access);
  return { ...previous, type: 'oauth', access, refresh: data.refresh_token || previous.refresh || '',
    expires: Number.isFinite(data.expires_in) ? Date.now() + data.expires_in * 1000 : expires(claims.exp),
    accountName: claims.email || previous.accountName, uid: claims.sub || previous.uid };
}
export async function json(fetcher: typeof fetch, url: string | URL, init: RequestInit = {}): Promise<Json> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new ChannelError(response.status); }
  return record(await readJson(response));
}
export async function readJson(response: Response): Promise<unknown> {
  try { return JSON.parse(await readText(response)); } catch (error) { if (error instanceof ChannelError) throw error; throw new ChannelError(502, 'SUBSCRIPTION_INVALID_RESPONSE'); }
}
export async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) throw new ChannelError(502);
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const p = await reader.read(); if (p.done) break; bytes += p.value.length; if (bytes > 4 * 1024 * 1024) throw new ChannelError(502, 'SUBSCRIPTION_RESPONSE_TOO_LARGE'); chunks.push(p.value); }
    return Buffer.concat(chunks).toString();
  } finally { await reader.cancel(); }
}
export function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) };
}
export function bearer(auth: SubscriptionAuth): Record<string, string> { return { authorization: `Bearer ${token(auth.access ?? auth.key)}` }; }
export function modelRows(rows: unknown, key = 'id'): Record<string, SubscriptionModel> {
  if (!Array.isArray(rows)) throw new ChannelError(502, 'SUBSCRIPTION_MODELS_FAILED');
  const result: Record<string, SubscriptionModel> = Object.create(null);
  for (const row of rows) if (row && typeof row[key] === 'string' && row[key].length <= 200 && !/[\x00-\x1f]/.test(row[key])) result[row[key]] = { name: row.display_name || row.name || row[key] };
  if (!Object.keys(result).length) throw new ChannelError(502, 'SUBSCRIPTION_MODELS_FAILED');
  return result;
}
export async function poll<T>(check: () => Promise<T | undefined>, interval = 2000, timeout = 10 * 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result !== undefined) return result; await delay(Math.min(interval, Math.max(1, deadline - Date.now()))); }
  throw new Error('SUBSCRIPTION_LOGIN_TIMEOUT');
}
export function httpsOrigin(value: string): string {
  const url = new URL(value.includes('://') ? value : 'https://' + value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) throw new Error('SUBSCRIPTION_INPUT_INVALID');
  return url.origin;
}
/** Keep quota refusals eligible for the gateway's existing cooldown and fallback. */
export async function quotaResponse(response: Response): Promise<Response> {
  if (![402, 403].includes(response.status)) return response;
  const text = await readText(response);
  const quota = /insufficient[_ ](?:balance|quota)|usage limit|quota[_ ]exhausted|credits? (?:exhausted|insufficient)|余额不足|额度.*(?:不足|用完)/i.test(text);
  return new Response(text, { status: quota ? 429 : response.status, headers: response.headers });
}

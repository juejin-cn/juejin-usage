import { failureHeaders } from '../failure-codes.js';
import { readText, type Json } from './http.js';

/** Only fixed categories and validated retry delays leave this adapter. */
export function googleDiagnostic(status: number, payload: Json, upstreamHeaders?: Headers): Record<string, string> {
  const error = payload.error ?? payload.response?.error ?? {};
  const details: Json[] = Array.isArray(error.details) ? error.details : [];
  const reasons = details.filter(d => d && typeof d === 'object' && String(d['@type'] ?? '').endsWith('/google.rpc.ErrorInfo')).map(d => d.reason);
  let code: string | undefined;
  if (status === 429 || status === 503) {
    if (reasons.some(r => ['MODEL_CAPACITY_EXHAUSTED', 'CAPACITY_EXHAUSTED'].includes(r))) code = 'UPSTREAM_CAPACITY_EXHAUSTED';
    else if (typeof error.message === 'string' && /\bno capacity available\b/i.test(error.message)) code = 'UPSTREAM_CAPACITY_EXHAUSTED';
  }
  if (status === 429) {
    if (!code && reasons.includes('RATE_LIMIT_EXCEEDED')) code = 'UPSTREAM_RATE_LIMITED';
    if (!code && (reasons.some(r => ['QUOTA_EXCEEDED', 'DAILY_LIMIT_EXCEEDED'].includes(r)) || details.some(d => d && String(d['@type'] ?? '').endsWith('/google.rpc.QuotaFailure')))) code = 'UPSTREAM_QUOTA_EXHAUSTED';
    if (!code && error.status === 'RESOURCE_EXHAUSTED') code = 'UPSTREAM_RESOURCE_EXHAUSTED';
  }
  if (status === 400 && error.status === 'INVALID_ARGUMENT') code = 'UPSTREAM_INVALID_ARGUMENT';
  if (status === 403 && error.status === 'PERMISSION_DENIED') code = 'UPSTREAM_PERMISSION_DENIED';
  const headers = failureHeaders(code, status);
  const supplied = upstreamHeaders?.get('retry-after');
  if (supplied && supplied.length < 100 && (/^\d+(?:\.\d+)?$/.test(supplied) || Number.isFinite(Date.parse(supplied)))) headers['retry-after'] = supplied;
  if (!headers['retry-after']) {
    const retry = details.find(d => d && String(d['@type'] ?? '').endsWith('/google.rpc.RetryInfo'))?.retryDelay;
    if (typeof retry === 'string' && /^\d+(?:\.\d{1,9})?s$/.test(retry)) {
      const seconds = Number(retry.slice(0, -1));
      if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) headers['retry-after'] = String(seconds);
    }
  }
  return headers;
}

/** Embedded errors use either HTTP status codes or canonical Google RPC codes. */
export function googleErrorStatus(error: Json): number {
  const code = Number(error.code);
  if (Number.isInteger(code) && code >= 400 && code <= 599) return code;
  const statuses: Record<string, number> = { INVALID_ARGUMENT: 400, UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404, RESOURCE_EXHAUSTED: 429, INTERNAL: 500, UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504 };
  const canonical: Record<number, number> = { 3: 400, 5: 404, 7: 403, 8: 429, 13: 500, 14: 503, 16: 401, 4: 504 };
  return (typeof error.status === 'string' && Object.hasOwn(statuses, error.status) ? statuses[error.status] : undefined) ?? canonical[code] ?? 502;
}

export async function googleFailure(response: Response): Promise<Response> {
  let payload: Json = {};
  try {
    const parsed = JSON.parse(await readText(response));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch { /* Preserve HTTP status for non-JSON or oversized error bodies. */ }
  const headers = googleDiagnostic(response.status, payload, response.headers);
  return Response.json({ error: { message: response.status === 401 ? 'SUBSCRIPTION_LOGIN_REQUIRED' : 'SUBSCRIPTION_UPSTREAM_FAILED' } }, { status: response.status, headers });
}

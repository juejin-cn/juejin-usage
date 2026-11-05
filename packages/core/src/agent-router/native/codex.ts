import { codexMetadata } from '../channels/model-metadata.js';
import { sanitizeModelMetadata } from '../model-metadata.js';
// Native subscription channel; architectural sources are recorded in README.md.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { SubscriptionAuth, SubscriptionChannel } from '../subscription-types.js';

const CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const BASE = 'https://chatgpt.com/backend-api/codex';
const TOKEN = 'https://auth.openai.com/oauth/token';
const VERSION = '0.159.0'; // Catalog client version pinned with this adapter.
const redirect = 'http://localhost:1455/auth/callback';
function decodeTokenClaims(token: unknown): Record<string, any> {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return {}; }
}
export function codexCredentials(data: Record<string, any>, previous: SubscriptionAuth = {}): SubscriptionAuth {
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
  const access = decodeTokenClaims(data.access_token); const id = decodeTokenClaims(data.id_token);
  const account = id['https://api.openai.com/auth'] ?? access['https://api.openai.com/auth'] ?? {};
  return { ...previous, type: 'oauth', access: data.access_token, refresh: data.refresh_token || previous.refresh,
    expires: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : Number(access.exp) * 1000,
    accountId: account.chatgpt_account_id || previous.accountId, accountName: id.email || previous.accountName,
    plan: account.chatgpt_plan_type || previous.plan };
}
function buildSubscriptionHeaders(auth: SubscriptionAuth): Record<string, string> {
  return { authorization: `Bearer ${auth.access}`, ...(typeof auth.accountId === 'string' ? { 'chatgpt-account-id': auth.accountId } : {}),
    originator: 'codex_cli_rs', 'user-agent': `codex_cli_rs/${VERSION}`, version: VERSION, 'OpenAI-Beta': 'responses=experimental' };
}
async function requestOAuthTokens(form: Record<string, string>, fetcher: typeof fetch) {
  const response = await fetcher(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT, ...form }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'SUBSCRIPTION_LOGIN_REQUIRED' : 'SUBSCRIPTION_LOGIN_FAILED');
  return await response.json() as Record<string, any>;
}
export async function codexLogin(fetcher: typeof fetch = fetch, port = 1455) {
  const verifier = randomBytes(32).toString('base64url'); const state = randomBytes(32).toString('base64url');
  let settle: (value: SubscriptionAuth) => void; let reject: (error: Error) => void; let finishing = false;
  const result = new Promise<SubscriptionAuth>((resolve, fail) => { settle = resolve; reject = fail; });
  // A timeout may happen before the worker starts awaiting the callback.
  void result.catch(() => {});
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', redirect);
    if (url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
    const supplied = Buffer.from(url.searchParams.get('state') || ''); const expected = Buffer.from(state);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(400).end('Invalid authorization state'); return; }
    if (finishing) { res.writeHead(409).end(); return; }
    finishing = true;
    try {
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
      const auth = codexCredentials(await requestOAuthTokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect }, fetcher));
      if (!auth.refresh || !auth.accountId) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('登录成功，请返回应用。');
      settle!(auth);
    } catch { res.writeHead(400).end('Authorization failed'); reject!(new Error('SUBSCRIPTION_LOGIN_FAILED')); }
    finally { clearTimeout(timer); server.close(); server.closeIdleConnections(); }
  });
  const timer = setTimeout(() => { server.close(); server.closeAllConnections(); reject!(new Error('SUBSCRIPTION_LOGIN_TIMEOUT')); }, 10 * 60_000);
  try {
    await new Promise<void>((resolve, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', resolve); });
  } catch { clearTimeout(timer); throw new Error('SUBSCRIPTION_CODEX_PORT_BUSY'); }
  const params = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: redirect,
    scope: 'openid profile email offline_access', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs' });
  return { url: `https://auth.openai.com/oauth/authorize?${params}`, method: 'auto' as const, callback: () => result,
    cancel: () => { clearTimeout(timer); server.close(); server.closeAllConnections(); reject!(new Error('SUBSCRIPTION_CANCELLED')); } };
}
export function codexChannel(fetcher: typeof fetch = fetch): SubscriptionChannel {
  return {
    models: async auth => {
      const response = await fetcher(`${BASE}/models?client_version=${VERSION}`, { headers: buildSubscriptionHeaders(auth), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('SUBSCRIPTION_MODELS_FAILED');
      const data = await response.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string; input_modalities?: string[]; context_window?: number; max_context_window?: number; supports_reasoning_summaries?: boolean }> };
      return Object.fromEntries((data.models ?? []).filter(m => typeof m.slug === 'string' && m.visibility !== 'hidden')
        .map(m => [m.slug!, sanitizeModelMetadata({ ...codexMetadata(m), name: m.display_name || m.slug })]));
    },
    auth: {
      methods: [{ type: 'oauth', label: '使用 ChatGPT 登录', authorize: () => codexLogin(fetcher) }],
      refresh: async auth => codexCredentials(await requestOAuthTokens({ grant_type: 'refresh_token', refresh_token: String(auth.refresh) }, fetcher), auth),
      usage: async getAuth => {
        const auth = await getAuth(); const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', { headers: buildSubscriptionHeaders(auth), signal: AbortSignal.timeout(15000) });
        if (response.status === 401) return { signIn: 'expired' };
        if (!response.ok) throw new Error('SUBSCRIPTION_FAILED');
        const data = await response.json() as Record<string, any>;
        return { plan: data.plan_type ?? auth.plan, windows: [data.rate_limit?.primary_window, data.rate_limit?.secondary_window].filter(Boolean)
          .map(w => ({ used: w.used_percent, ...(Number.isFinite(w.reset_at) ? { resetsAt: new Date(w.reset_at * 1000).toISOString() } : {}) })) };
      },
      transport: async getAuth => ({ baseURL: BASE, fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const streaming = body.stream === true;
        body.store = false; body.stream = true; body.instructions ??= '';
        // The subscription Responses endpoint doesn't accept API billing controls.
        for (const key of ['max_output_tokens', 'temperature', 'top_p', 'user']) delete body[key];
        const signed = { ...Object.fromEntries(new Headers(init?.headers)), ...buildSubscriptionHeaders(await getAuth()), accept: 'text/event-stream' };
        if (typeof body.prompt_cache_key === 'string') Object.assign(signed, { 'session-id': body.prompt_cache_key, 'thread-id': body.prompt_cache_key });
        const response = await fetcher(BASE + '/responses', { ...init, headers: signed, body: JSON.stringify(body) });
        if (streaming || !response.ok) return response;
        // Codex always streams; whole-response clients receive the completed response object.
        const reader = response.body?.getReader(); if (!reader) throw new Error('SUBSCRIPTION_FAILED');
        let buffer = ''; const decoder = new TextDecoder();
        try {
          for (;;) {
            const part = await reader.read(); buffer = (buffer + decoder.decode(part.value, { stream: !part.done })).replace(/\r\n/g, '\n');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const raw = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
              if (!raw || raw === '[DONE]') continue;
              const data = JSON.parse(raw);
              if (data.type === 'response.completed' || data.type === 'response.incomplete') return Response.json(data.response);
              if (data.type === 'response.failed' || data.type === 'error') throw new Error('SUBSCRIPTION_FAILED');
            }
            if (buffer.length > 8 * 1024 * 1024) throw new Error('SUBSCRIPTION_FAILED');
            if (part.done) throw new Error('SUBSCRIPTION_FAILED');
          }
        } finally { await reader.cancel(); }
      } }),
    },
  };
}

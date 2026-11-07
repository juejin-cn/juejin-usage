import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SubscriptionAuth } from '../subscription-types.js';
import { json, oauth, post, token } from '../channels/http.js';

// Public installed-app identity, shared with Antigravity's OAuth integrations.
export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const ANTIGRAVITY_CLIENT_SECRET = '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';
const root = 'https://daily-cloudcode-pa.googleapis.com';
const scopes = ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map(scope => 'https://www.googleapis.com/auth/' + scope);
const projectId = (value: unknown) => typeof value === 'string' ? value : value && typeof value === 'object' ? (value as { id?: string }).id : undefined;

export async function antigravityProject(access: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  const headers = { authorization: `Bearer ${token(access)}`, 'content-type': 'application/json', 'user-agent': 'antigravity' };
  const load = await json(fetcher, root + '/v1internal:loadCodeAssist', { ...post({ metadata: { ideType: 'ANTIGRAVITY' } }, headers), signal });
  const existing = projectId(load.cloudaicompanionProject);
  if (existing) return token(existing);
  if (load.ineligibleTiers?.length && !load.allowedTiers?.length) throw new Error('SUBSCRIPTION_ANTIGRAVITY_ACCOUNT_UNAVAILABLE');
  const tier = load.allowedTiers?.find((tier: { isDefault?: boolean }) => tier.isDefault) ?? load.allowedTiers?.[0];
  const tierId = !tier?.id || tier.id === 'legacy-tier' ? 'free-tier' : tier.id;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await json(fetcher, root + '/v1internal:onboardUser', { ...post({ tier_id: tierId, metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity' } }, headers), signal });
    if (result.done) {
      const project = projectId(result.response?.cloudaicompanionProject);
      if (project) return token(project);
      break;
    }
    if (attempt < 4) await delay(2000, undefined, { signal });
  }
  throw new Error('SUBSCRIPTION_ANTIGRAVITY_PROJECT_UNAVAILABLE');
}

/** State-checked PKCE flow; cancellation/worker termination releases the loopback port. */
export async function antigravityLogin(fetcher: typeof fetch = fetch, options: { port?: number; timeoutMs?: number } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const abort = new AbortController();
  let resolve!: (auth: SubscriptionAuth) => void;
  let reject!: (error: Error) => void;
  let finishing = false; let settled = false;
  const result = new Promise<SubscriptionAuth>((done, fail) => { resolve = done; reject = fail; });
  void result.catch(() => {});
  let redirect = '';
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', redirect);
      if (req.method !== 'GET' || url.pathname !== '/oauth-callback') { res.writeHead(404).end(); return; }
      if (req.headers.origin || ![new URL(redirect).host, new URL(redirect).host.replace('localhost', '127.0.0.1')].includes(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
      const actual = Buffer.from(url.searchParams.get('state') ?? ''); const expected = Buffer.from(state);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(400).end('Invalid authorization state'); return; }
      if (finishing || settled) { res.writeHead(409).end(); return; }
      finishing = true;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      try {
        if (url.searchParams.has('error')) throw new Error('SUBSCRIPTION_ANTIGRAVITY_LOGIN_DECLINED');
        const code = url.searchParams.get('code');
        if (!code) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
        const data = await json(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET, code, redirect_uri: redirect, code_verifier: verifier }) });
        const auth = oauth(data);
        if (!auth.refresh) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
        const who = await json(fetcher, 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json', { signal: abort.signal, headers: { authorization: `Bearer ${token(auth.access)}` } });
        const email = token(who.email);
        const project = await antigravityProject(token(auth.access), fetcher, abort.signal);
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve({ ...auth, project, uid: typeof who.id === 'string' ? who.id : email, email, accountName: email });
        res.writeHead(200).end('登录成功，请返回应用。');
      } catch (cause) {
        if (!settled) {
          settled = true; clearTimeout(timer);
          const message = cause instanceof Error && /^SUBSCRIPTION_[A-Z_]+$/.test(cause.message) ? cause.message : 'SUBSCRIPTION_LOGIN_FAILED';
          reject(new Error(message));
          res.writeHead(400).end('登录未完成，请返回应用重试。');
        }
      } finally { server.close(); server.closeIdleConnections(); }
    })().catch(() => { if (!res.headersSent) res.writeHead(400).end('Invalid callback'); else res.destroy(); });
  });
  const cancel = (code = 'SUBSCRIPTION_CANCELLED') => {
    if (settled) return;
    settled = true; clearTimeout(timer); abort.abort(); server.close(); server.closeAllConnections(); reject(new Error(code));
  };
  const timer = setTimeout(() => cancel('SUBSCRIPTION_LOGIN_TIMEOUT'), options.timeoutMs ?? 10 * 60_000);
  try {
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(options.port ?? 51121, '127.0.0.1', () => { server.off('error', fail); done(); }); });
  } catch {
    cancel('SUBSCRIPTION_ANTIGRAVITY_PORT_BUSY');
    throw new Error('SUBSCRIPTION_ANTIGRAVITY_PORT_BUSY');
  }
  redirect = `http://localhost:${(server.address() as { port: number }).port}/oauth-callback`;
  const params = new URLSearchParams({ client_id: ANTIGRAVITY_CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params, method: 'auto' as const, callback: () => result, cancel: () => cancel() };
}

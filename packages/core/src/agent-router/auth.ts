import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { object, RouterError, type RouterProvider } from './config.js';
import { RouterCredentialStore, validApiKey } from './credential-store.js';
import { RouterSubscriptions } from './subscriptions.js';

export function secretEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
interface Token { access: string; refresh?: string; expiresAt: number }
interface Session { provider: RouterProvider; verifier: string; redirectUri: string; expiresAt: number }

/** Owned tokens may be persisted; never refresh or overwrite another agent's token store. */
export class RouterCredentials {
  private tokens = new Map<string, Token>();
  private sessions = new Map<string, Session>();
  private refreshing = new Map<string, Promise<Token>>();
  private requests = new Set<AbortController>();
  private generation = 0;
  private epochs = new Map<string, number>();
  readonly subscriptions: RouterSubscriptions;
  constructor(private env: NodeJS.ProcessEnv = process.env, private now = Date.now, subscriptions?: RouterSubscriptions, readonly store?: RouterCredentialStore) {
    this.subscriptions = subscriptions ?? new RouterSubscriptions(env, undefined, store);
  }
  ready(provider: RouterProvider): boolean {
    if (provider.auth.kind === 'subscription') return this.subscriptions.ready(provider);
    if (provider.auth.kind === 'env') {
      const saved = this.store?.get(provider);
      const key = saved?.kind === 'api' ? saved.key : this.env[provider.auth.variable]?.trim();
      return !!key && !/[\r\n]/.test(key);
    }
    const saved = this.store?.get(provider);
    const token = this.tokens.get(provider.id) ?? (saved?.kind === 'oauth' ? saved : undefined);
    return !!token && (token.expiresAt > this.now() + 30_000 || !!token.refresh);
  }
  clear(): void {
    this.generation++;
    this.requests.forEach(request => request.abort()); this.requests.clear();
    this.tokens.clear(); this.sessions.clear(); this.refreshing.clear();
    this.subscriptions.clear();
  }
  forget(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.tokens.delete(id); this.refreshing.delete(id);
    for (const [state, session] of this.sessions) if (session.provider.id === id) this.sessions.delete(state);
    void this.subscriptions.cancel(id);
  }
  async importKey(provider: RouterProvider, key: string): Promise<void> {
    if (provider.auth.kind !== 'env') throw new RouterError('CREDENTIAL_IMPORT_UNSUPPORTED');
    if (!validApiKey(key)) throw new RouterError('CREDENTIAL_INVALID');
    if (!this.store) throw new RouterError('CREDENTIAL_STORE_UNAVAILABLE', 503);
    await this.store.set(provider, { kind: 'api', key });
  }
  async logout(provider: RouterProvider): Promise<void> {
    this.forget(provider.id);
    await this.store?.delete(provider);
  }
  begin(provider: RouterProvider, redirectUri: string): string {
    if (provider.auth.kind !== 'oauth') throw new RouterError('OAUTH_NOT_CONFIGURED');
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 16) throw new RouterError('OAUTH_SESSION_LIMIT', 429);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.sessions.set(state, { provider: structuredClone(provider), verifier, redirectUri, expiresAt: this.now() + 5 * 60_000 });
    const url = new URL(provider.auth.authorizeUrl);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: provider.auth.clientId, redirect_uri: redirectUri, scope: provider.auth.scopes.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return url.href;
  }
  async complete(query: URLSearchParams): Promise<string> {
    const state = query.get('state') ?? '';
    const session = this.sessions.get(state);
    if (!session || session.expiresAt <= this.now()) { this.sessions.delete(state); throw new RouterError('OAUTH_STATE_INVALID'); }
    this.sessions.delete(state); // Consume before exchange, even on denial/failure.
    if (query.has('error') || !query.get('code') || query.getAll('state').length !== 1 || query.getAll('code').length !== 1) throw new RouterError('OAUTH_DENIED');
    const generation = this.generation; const epoch = this.epochs.get(session.provider.id);
    const token = await this.exchange(session.provider, { grant_type: 'authorization_code', code: query.get('code')!, code_verifier: session.verifier, redirect_uri: session.redirectUri });
    if (generation !== this.generation || epoch !== this.epochs.get(session.provider.id)) throw new RouterError('OAUTH_SESSION_CANCELLED');
    await this.store?.set(session.provider, { kind: 'oauth', ...token });
    if (generation !== this.generation || epoch !== this.epochs.get(session.provider.id)) throw new RouterError('OAUTH_SESSION_CANCELLED');
    this.tokens.set(session.provider.id, token);
    return session.provider.id;
  }
  /** Opaque account binding, never exposed to a client or trace. */
  async stateIdentity(provider: RouterProvider): Promise<string> {
    const resolved = provider.auth.kind === 'subscription' ? undefined : await this.resolve(provider);
    const saved = this.store?.get(provider);
    let subject: unknown = provider.auth.kind === 'subscription'
      ? saved ?? { variable: provider.auth.variable ? this.env[provider.auth.variable] : undefined, generation: this.generation, epoch: this.epochs.get(provider.id) }
      : provider.auth.kind === 'env' ? resolved : saved ?? this.tokens.get(provider.id);
    if (provider.auth.kind === 'subscription' && saved?.kind === 'subscription' && saved.auth.type === 'oauth') {
      const a = saved.auth;
      if (provider.auth.provider === 'codex' && typeof a.accountId === 'string' && a.accountId) subject = { accountId: a.accountId };
      else if (provider.auth.provider === 'claude' && a.source === 'claude-code-local' && typeof a.accountName === 'string' && a.accountName) subject = { accountName: a.accountName, organizationId: a.organizationId, source: a.source };
      else if (typeof a.uid === 'string' && a.uid) subject = Object.fromEntries(['uid', 'host', 'origin', 'enterpriseId', 'site'].map(key => [key, a[key]]));
    }
    return createHash('sha256').update(JSON.stringify([provider.id, provider.baseUrl, provider.protocol, provider.auth, subject, this.generation, this.epochs.get(provider.id)])).digest('hex');
  }
  async resolve(provider: RouterProvider): Promise<string> {
    if (provider.auth.kind === 'subscription') throw new RouterError('SUBSCRIPTION_TRANSPORT_REQUIRED');
    if (provider.auth.kind === 'env') {
      const saved = this.store?.get(provider);
      const key = saved?.kind === 'api' ? saved.key : this.env[provider.auth.variable]?.trim();
      if (!key || /[\r\n]/.test(key)) throw new RouterError('CREDENTIAL_UNAVAILABLE', 503);
      return key;
    }
    const saved = this.store?.get(provider);
    const token = this.tokens.get(provider.id) ?? (saved?.kind === 'oauth' ? saved : undefined);
    if (!token) throw new RouterError('OAUTH_LOGIN_REQUIRED', 503);
    if (token.expiresAt > this.now() + 30_000) return token.access;
    if (!token.refresh) { this.tokens.delete(provider.id); throw new RouterError('OAUTH_LOGIN_REQUIRED', 503); }
    let pending = this.refreshing.get(provider.id);
    if (!pending) {
      const generation = this.generation; const epoch = this.epochs.get(provider.id);
      pending = this.exchange(provider, { grant_type: 'refresh_token', refresh_token: token.refresh })
        .then(async next => {
          if (generation !== this.generation || epoch !== this.epochs.get(provider.id)) throw new RouterError('OAUTH_SESSION_CANCELLED');
          next.refresh ??= token.refresh;
          await this.store?.set(provider, { kind: 'oauth', ...next });
          if (generation !== this.generation || epoch !== this.epochs.get(provider.id)) throw new RouterError('OAUTH_SESSION_CANCELLED');
          this.tokens.set(provider.id, next); return next;
        }).catch(error => { if (generation === this.generation && epoch === this.epochs.get(provider.id)) this.tokens.delete(provider.id); throw error; })
        .finally(() => { if (generation === this.generation && epoch === this.epochs.get(provider.id)) this.refreshing.delete(provider.id); });
      this.refreshing.set(provider.id, pending);
    }
    return (await pending).access;
  }
  private async exchange(provider: RouterProvider, fields: Record<string, string>): Promise<Token> {
    if (provider.auth.kind !== 'oauth') throw new RouterError('OAUTH_NOT_CONFIGURED');
    const abort = new AbortController(); this.requests.add(abort);
    const timer = setTimeout(() => abort.abort(), 15_000); timer.unref();
    try {
      const response = await fetch(provider.auth.tokenUrl, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...fields, client_id: provider.auth.clientId }),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new RouterError('OAUTH_EXCHANGE_FAILED', 502); }
      const parts: Uint8Array[] = []; let size = 0;
      for await (const part of response.body) { size += part.length; if (size > 65536) throw new RouterError('OAUTH_RESPONSE_TOO_LARGE', 502); parts.push(part); }
      const data = object(JSON.parse(Buffer.concat(parts).toString('utf8')));
      if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token) ||
          (data.token_type !== undefined && String(data.token_type).toLowerCase() !== 'bearer') ||
          (data.expires_in !== undefined && (!Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0))) throw new RouterError('OAUTH_INVALID_TOKEN', 502);
      return { access: data.access_token, refresh: typeof data.refresh_token === 'string' ? data.refresh_token : undefined, expiresAt: this.now() + Number(data.expires_in ?? 3600) * 1000 };
    } catch (error) { if (error instanceof RouterError) throw error; throw new RouterError('OAUTH_EXCHANGE_FAILED', 502); }
    finally { clearTimeout(timer); this.requests.delete(abort); }
  }
}

export interface LocalLoginStatus { id: string; state: 'detected' | 'missing' | 'unreadable'; inference: false }
/** Metadata only: subscription credentials are not API keys. No tokens cross IPC. */
export async function discoverLocalLogins(home = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<LocalLoginStatus[]> {
  const stores = [
    { id: 'codex', path: join(env.CODEX_HOME || join(home, '.codex'), 'auth.json'), detect: (data: Record<string, unknown>) => !!data.OPENAI_API_KEY || !!object(data.tokens ?? {}).access_token },
    { id: 'claude-code', path: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json'), detect: (data: Record<string, unknown>) => !!object(data.claudeAiOauth ?? {}).accessToken },
  ];
  return Promise.all(stores.map(async store => {
    try {
      const raw = await readFile(store.path, 'utf8');
      return { id: store.id, state: store.detect(object(JSON.parse(raw))) ? 'detected' : 'missing', inference: false } as LocalLoginStatus;
    } catch (error) { return { id: store.id, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', inference: false } as LocalLoginStatus; }
  }));
}

import type { ModelCatalog } from './model-metadata.js';
import type { ProviderUsage } from './usage.js';
import { failureHeaders } from './failure-codes.js';
import { MessageChannel, Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { RouterError, type RouterProvider } from './config.js';
import { RouterCredentialStore } from './credential-store.js';
import type { LoginMethod, LoginOptions, LoginResult, SubscriptionCommand, SubscriptionState } from './subscription-types.js';

interface Entry {
  provider: RouterProvider; touched: number; worker: Worker; state: SubscriptionState; close: Set<() => void>;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  children: Set<number>;
  loginTimer?: ReturnType<typeof setTimeout>;
}
export class RouterSubscriptions {
  private workers = new Map<string, Entry>();
  private terminating = new Set<Promise<number>>();
  constructor(private env: NodeJS.ProcessEnv = process.env, private workerUrl = new URL('./subscription-worker.js', import.meta.url), private store?: RouterCredentialStore) {}
  state(provider: RouterProvider): SubscriptionState {
    const state = this.workers.get(provider.id)?.state;
    if (state) return { ...state };
    const a = provider.auth;
    const saved = this.store?.get(provider);
    if (saved?.kind === 'subscription') return { phase: 'ready', error: null, authType: saved.auth.type === 'api' ? 'api' : 'oauth' };
    return { phase: a.kind === 'subscription' && a.method === 'env' && this.key(a.variable) ? 'ready' : 'signed-out', error: null };
  }
  ready(provider: RouterProvider): boolean { return this.state(provider).phase === 'ready'; }
  private key(variable?: string): string | undefined {
    const key = variable ? this.env[variable]?.trim() : undefined;
    return key && !/[\r\n\x00]/.test(key) ? key : undefined;
  }
  private create(provider: RouterProvider, restore = true): Entry {
    const existing = this.workers.get(provider.id); if (existing) { existing.touched = Date.now(); return existing; }
    const auth = provider.auth;
    if (auth.kind !== 'subscription') throw new RouterError('SUBSCRIPTION_NOT_CONFIGURED');
    if (this.workers.size >= 8) {
      const idle = [...this.workers.entries()].filter(([, entry]) => entry.state.phase !== 'authorizing' && !entry.pending.size && !entry.close.size
        && (entry.state.phase !== 'ready' || this.store?.get(entry.provider)?.kind === 'subscription'))
        .sort(([, a], [, b]) => a.touched - b.touched)[0];
      if (idle) { this.dispose(idle[1]); this.workers.delete(idle[0]); }
      else throw new RouterError('SUBSCRIPTION_WORKER_LIMIT', 429);
    }
    const secret = this.key(auth.variable);
    const saved = restore ? this.store?.get(provider) : undefined;
    if (['env', 'pat-env'].includes(auth.method) && !secret && saved?.kind !== 'subscription') throw new RouterError('CREDENTIAL_UNAVAILABLE', 503);
    const worker = new Worker(this.workerUrl, { workerData: { provider: auth.provider, method: auth.method, protocol: provider.protocol, secret, auth: saved?.kind === 'subscription' ? saved.auth : undefined, persist: !!this.store }, execArgv: [], stdout: true, stderr: true });
    // Adapter errors may contain vendor details; never route worker logs to the host log.
    worker.stdout.resume(); worker.stderr.resume();
    const entry: Entry = { provider, touched: Date.now(), worker, state: this.state(provider), close: new Set(), pending: new Map(), children: new Set() };
    const fail = () => {
      this.killChildren(entry);
      entry.state = { phase: 'error', error: 'SUBSCRIPTION_ADAPTER_UNAVAILABLE' };
      for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new RouterError('SUBSCRIPTION_CANCELLED', 503)); }
      entry.pending.clear(); entry.close.forEach(close => close()); entry.close.clear();
      if (entry.loginTimer) clearTimeout(entry.loginTimer);
    };
    worker.on('error', fail); worker.on('exit', fail);
    worker.on('message', async message => {
      if (Number.isSafeInteger(message.childPid) && message.childPid > 0) {
        if (message.running && this.workers.get(provider.id) !== entry) {
          try { process.kill(message.childPid, 'SIGTERM'); } catch {}
        } else if (message.running) entry.children.add(message.childPid);
        else entry.children.delete(message.childPid);
        return;
      }
      if (this.workers.get(provider.id) !== entry) return;
      if (message.credentialId) {
        try {
          await this.store?.set(provider, { kind: 'subscription', auth: message.auth });
          if (this.workers.get(provider.id) === entry) worker.postMessage({ credentialId: message.credentialId });
        } catch {
          entry.state = { phase: 'error', error: 'CREDENTIAL_SAVE_FAILED' };
          worker.postMessage({ credentialId: message.credentialId, error: true });
        }
        return;
      }
      if (message.status) {
        entry.state = message.status;
        if (entry.state.phase !== 'authorizing' && entry.loginTimer) { clearTimeout(entry.loginTimer); entry.loginTimer = undefined; }
      }
      if (message.id) {
        const pending = entry.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); entry.pending.delete(message.id);
        if (message.error) pending.reject(new RouterError(message.error, 502)); else pending.resolve(message.result);
      }
    });
    this.workers.set(provider.id, entry); return entry;
  }
  private call<T>(entry: Entry, kind: 'login' | 'methods' | 'complete' | 'models' | 'usage', options: Partial<SubscriptionCommand> = {}): Promise<T> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { entry.pending.delete(id); if (kind !== 'usage') this.dispose(entry); reject(new RouterError('SUBSCRIPTION_TIMEOUT', 504)); }, 35_000); timer.unref();
      entry.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); entry.worker.postMessage({ ...options, id, kind });
    });
  }
  async begin(provider: RouterProvider, options: LoginOptions = {}): Promise<LoginResult> {
    const previous = this.workers.get(provider.id);
    if (previous?.state.phase === 'authorizing') throw new RouterError('SUBSCRIPTION_LOGIN_BUSY', 409);
    if (previous) { this.dispose(previous); this.workers.delete(provider.id); }
    const entry = this.create(provider, false);
    entry.state = { phase: 'authorizing', error: null };
    entry.loginTimer = setTimeout(() => { this.dispose(entry); entry.state = { phase: 'error', error: 'SUBSCRIPTION_LOGIN_TIMEOUT' }; }, 15 * 60_000); entry.loginTimer.unref();
    return this.call(entry, 'login', options);
  }
  async methods(provider: RouterProvider, inputs: Record<string, string> = {}): Promise<LoginMethod[]> {
    return this.call(this.create(provider), 'methods', { inputs });
  }
  async complete(provider: RouterProvider, code: string): Promise<LoginResult> {
    const entry = this.workers.get(provider.id);
    if (!entry || entry.state.phase !== 'authorizing') throw new RouterError('SUBSCRIPTION_LOGIN_REQUIRED', 409);
    return this.call(entry, 'complete', { code });
  }
  async usage(provider: RouterProvider): Promise<ProviderUsage> {
    if (!this.ready(provider)) throw new RouterError('SUBSCRIPTION_LOGIN_REQUIRED', 409);
    return this.call(this.create(provider), 'usage');
  }
  async models(provider: RouterProvider): Promise<string[]> {
    if (!this.ready(provider)) throw new RouterError('SUBSCRIPTION_LOGIN_REQUIRED', 409);
    return (await this.modelCatalog(provider)).models;
  }
  async modelCatalog(provider: RouterProvider): Promise<ModelCatalog> {
    if (!this.ready(provider)) throw new RouterError('SUBSCRIPTION_LOGIN_REQUIRED', 409);
    return this.call(this.create(provider), 'models');
  }
  async fetch(provider: RouterProvider, body: Record<string, unknown>, signal: AbortSignal, session?: string, fallback = false, features: Record<string, string> = {}): Promise<Response> {
    if (!this.ready(provider)) throw new RouterError('SUBSCRIPTION_LOGIN_REQUIRED', 503);
    if (signal.aborted) throw new RouterError('REQUEST_CANCELLED', 499);
    const entry = this.create(provider); const { port1, port2 } = new MessageChannel();
    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let headersReceived = false; let finished = false;
      const cleanup = () => { if (finished) return; finished = true; signal.removeEventListener('abort', cancel); entry.close.delete(cancel); port1.close(); };
      const fail = (code: string) => { const error = new RouterError(code, code === 'SUBSCRIPTION_STREAM_REQUIRED' ? 400 : 502); if (!headersReceived) reject(error); else controller?.error(error); cleanup(); };
      const cancel = () => { port1.postMessage({ cancel: true }); fail('SUBSCRIPTION_CANCELLED'); };
      signal.addEventListener('abort', cancel, { once: true }); entry.close.add(cancel);
      port1.on('message', message => {
        if (finished) return;
        if (message.error) { fail(message.error); return; }
        if (message.headers) {
          headersReceived = true;
          if ([204, 205, 304].includes(message.status)) {
            resolve(new Response(null, { status: message.status })); port1.postMessage({ cancel: true }); cleanup(); return;
          }
          const stream = new ReadableStream<Uint8Array>({
            start(c) { controller = c; }, pull() { port1.postMessage({ next: true }); },
            cancel() { port1.postMessage({ cancel: true }); cleanup(); },
          }, { highWaterMark: 0 });
          resolve(new Response(stream, { status: message.status, headers: { 'content-type': message.contentType, ...failureHeaders(message.failureCode, message.status), ...(message.retryAfter ? { 'retry-after': message.retryAfter } : {}) } }));
        } else if (message.done) { controller?.close(); cleanup(); }
        else if (message.chunk) controller?.enqueue(message.chunk);
      });
      port1.on('close', () => { if (!finished) fail('SUBSCRIPTION_CANCELLED'); });
      entry.worker.postMessage({ id: randomUUID(), kind: 'request', body, session, fallback, features, port: port2 }, [port2]);
    });
  }
  private killChildren(entry: Entry): void {
    for (const pid of entry.children) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    entry.children.clear();
  }
  private dispose(entry: Entry): void {
    this.killChildren(entry);
    if (entry.loginTimer) clearTimeout(entry.loginTimer);
    entry.close.forEach(close => close()); entry.close.clear();
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(new RouterError('SUBSCRIPTION_CANCELLED', 503)); } entry.pending.clear();
    const terminated = entry.worker.terminate(); this.terminating.add(terminated);
    void terminated.finally(() => this.terminating.delete(terminated));
  }
  clear(): void { this.workers.forEach(entry => this.dispose(entry)); this.workers.clear(); }
  async cancel(providerId: string): Promise<void> {
    const entry = this.workers.get(providerId); if (!entry) return;
    this.dispose(entry); this.workers.delete(providerId);
    await Promise.allSettled(this.terminating);
  }
  async close(): Promise<void> { this.clear(); await Promise.allSettled(this.terminating); }
}

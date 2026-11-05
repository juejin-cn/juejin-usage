import { automaticGroups, effectiveGroups } from './groups.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { RouterCredentials, secretEqual } from './auth.js';
import { withoutRouterProvider, exposedModels, object, RouterError, validateRouterConfig, DEFAULT_GATEWAY_LIMITS, DEFAULT_PROVIDER_LIMITS, type AgentRouterConfig, type GatewayLimits, type Protocol } from './config.js';
import { AdmissionQueue } from './admission.js';
import { RoutingState, AttemptFailure, responseFailure, type FailureKind, type CandidateDecision } from './routing.js';
import { openTransport, type TransportReply } from './transport.js';
import { prepareReply } from './response.js';
import { convertRequest, convertReply } from './protocol/index.js';

const paths: Record<string, Protocol> = { '/v1/chat/completions': 'chat', '/v1/responses': 'responses', '/v1/messages': 'messages' };
export interface RouterAttempt {
  target: string; status: number; durationMs: number; queuedMs?: number; responseStartMs?: number;
  committed?: boolean; sent?: boolean; failure?: FailureKind; reason?: string;
}
export interface RouterTrace {
  id: string; startedAt: string; model?: string; protocol?: Protocol; status: number; durationMs: number;
  outcome: 'running' | 'completed' | 'failed' | 'cancelled'; attempts: RouterAttempt[];
  affinity?: boolean; phase?: string; queuedMs?: number; strategy?: string; decisions?: CandidateDecision[]; reason?: string;
}

function cancelled(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }
async function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', cancel, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', cancel); if (signal.aborted) { late?.(value); reject(signal.reason); } else resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
function classify(error: unknown): AttemptFailure {
  if (error instanceof AttemptFailure) return error;
  if (error instanceof RouterError) {
    if (/CANCELLED|DRAINING|DRAIN_TIMEOUT/.test(error.code)) return new AttemptFailure(error.code, error.status, 'cancelled', false);
    if (error.code === 'SUBSCRIPTION_LOGIN_REQUIRED' || error.code === 'OAUTH_LOGIN_REQUIRED') return new AttemptFailure(error.code, 401, 'authentication', false);
    if (error.code === 'UPSTREAM_PROTOCOL_ERROR') return responseFailure(error.status);
    if (error.code.startsWith('UPSTREAM_')) return new AttemptFailure(error.code, error.status, 'unavailable', true);
    return new AttemptFailure(error.code, error.status, /QUEUE_/.test(error.code) ? 'admission' : 'request', /QUEUE_/.test(error.code));
  }
  return new AttemptFailure('UPSTREAM_CONNECTION_FAILED', 502, 'transport', false);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
export async function readJson(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new RouterError('JSON_REQUIRED', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new RouterError('BODY_TOO_LARGE', 413); }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RouterError('INVALID_JSON'); }
}

/** Authenticated inference orchestration; management stays on the private host. */
export class AgentGateway {
  private server: Server | null = null;
  private active = new Set<AbortController>();
  private idle = new Set<() => void>();
  private traces: RouterTrace[] = [];
  private port = 0;
  private accessToken = '';
  private config: AgentRouterConfig | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private phase: 'stopped' | 'running' | 'draining' = 'stopped';
  private limits: GatewayLimits = { ...DEFAULT_GATEWAY_LIMITS };
  private global = new AdmissionQueue(this.limits);
  private lanes = new Map<string, AdmissionQueue>();
  private routing: RoutingState;
  constructor(readonly credentials: RouterCredentials, private options: { now?: () => number; onTrace?: (trace: RouterTrace) => void; accessToken?: () => Promise<string | undefined> } = {}) { this.routing = new RoutingState(options.now); }
  status() {
    return { running: this.phase !== 'stopped', phase: this.phase, port: this.port,
      baseUrl: this.port ? `http://127.0.0.1:${this.port}/v1` : null, active: this.active.size,
      admission: { global: this.global.status(), providers: [...this.lanes].map(([providerId, lane]) => ({ providerId, ...lane.status() })) },
      health: this.routing.snapshot(), automaticGroups: this.config ? automaticGroups(this.config) : [], requests: this.traces.map(t => structuredClone(t)) };
  }
  token(): string { return this.accessToken; }
  rotateToken(token: string): void { if (!/^(?:sk-)?[A-Za-z0-9_-]{43}$/.test(token)) throw new RouterError('INVALID_TOKEN'); if (this.server) this.accessToken = token; }
  resetHealth(providerId: string): void { this.routing.reset(providerId); }
  start(input: AgentRouterConfig): Promise<void> {
    const next = this.lifecycle.then(() => this.startListener(input)); this.lifecycle = next.catch(() => {}); return next;
  }
  private async startListener(input: AgentRouterConfig): Promise<void> {
    if (this.server) return;
    const config = validateRouterConfig(input);
    const accessToken = await this.options.accessToken?.() ?? `sk-${randomBytes(32).toString('base64url')}`;
    const server = createServer((req, res) => { void this.handle(req, res).catch(error => {
      if (!res.headersSent) {
        if (!req.complete) res.setHeader('connection', 'close');
        if (error instanceof RouterError && error.retryAfterMs) res.setHeader('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
        const status = error instanceof RouterError ? error.status : 502;
        const message = error instanceof RouterError ? error.code : 'GATEWAY_FAILED';
        const anthropic = req.url?.split('?')[0] === '/v1/messages';
        const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'api_error';
        sendJson(res, status, { ...(anthropic ? { type: 'error' } : {}), error: { message, type, ...(!anthropic ? { code: message } : {}) } });
      } else res.destroy();
    }); });
    server.requestTimeout = 20000; server.headersTimeout = 10000; server.maxConnections = 64;
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    this.config = config; this.server = server; this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...config.gateway };
    this.global = new AdmissionQueue(this.limits); this.lanes.clear(); this.routing.clear();
    this.port = (server.address() as { port: number }).port;
    this.accessToken = accessToken; this.phase = 'running';
  }
  /** Add channels or update selected models without interrupting active sessions. */
  addProviders(input: AgentRouterConfig, persist: (config: AgentRouterConfig) => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(async () => {
      const config = validateRouterConfig(input);
      const current = this.config;
      if (this.phase !== 'running' || !current) throw new RouterError('GATEWAY_STOPPED', 409);
      const { providers: before, ...previousSettings } = current;
      const { providers: after, ...nextSettings } = config;
      const connection = ({ models: _models, excludedModels: _excludedModels, ...provider }: typeof before[number]) => provider;
      if (JSON.stringify(config) === JSON.stringify(current) || JSON.stringify(previousSettings) !== JSON.stringify(nextSettings) || after.length < before.length
        || before.some((provider, index) => !after[index] || JSON.stringify(connection(provider)) !== JSON.stringify(connection(after[index])))) {
        throw new RouterError('STOP_GATEWAY_BEFORE_EDITING', 409);
      }
      await persist(config);
      this.config = config;
    });
    this.lifecycle = next.catch(() => {});
    return next;
  }
  /** Remove an account without restarting the listener; explicit removals also clean route groups. */
  removeProvider(providerId: string, persist: (config: AgentRouterConfig) => Promise<void>, pruneGroups = false): Promise<AgentRouterConfig> {
    const next = this.lifecycle.then(async () => {
      if (this.phase !== 'running' || !this.config) throw new RouterError('GATEWAY_STOPPED', 409);
      if (!pruneGroups && this.config.groups.some(group => group.members.some(member => member.startsWith(providerId + '/')))) {
        throw new RouterError('ACCOUNT_IN_USE', 409);
      }
      const config = withoutRouterProvider(this.config, providerId);
      await persist(config);
      this.config = config;
      return config;
    });
    this.lifecycle = next.then(() => {}, () => {});
    return next;
  }
  stop(): Promise<void> { const next = this.lifecycle.then(() => this.stopListener()); this.lifecycle = next.catch(() => {}); return next; }
  private waitIdle(ms: number): Promise<void> {
    if (!this.active.size || !ms) return Promise.resolve();
    return new Promise(resolve => { const done = () => { clearTimeout(timer); this.idle.delete(done); resolve(); }; const timer = setTimeout(done, ms); this.idle.add(done); });
  }
  private async stopListener(): Promise<void> {
    const server = this.server;
    if (!server) { this.credentials.clear(); await this.credentials.subscriptions.close(); return; }
    this.phase = 'draining'; this.global.close(); this.lanes.forEach(lane => lane.close());
    const closed = new Promise<void>(resolve => { server.close(() => resolve()); });
    await this.waitIdle(this.limits.drainTimeoutMs);
    this.active.forEach(controller => controller.abort(new RouterError('GATEWAY_DRAIN_TIMEOUT', 503)));
    this.credentials.clear(); await this.credentials.subscriptions.close(); server.closeAllConnections();
    await closed; await this.waitIdle(100);
    this.server = null; this.port = 0; this.accessToken = ''; this.config = null; this.phase = 'stopped'; this.routing.clear();
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = `127.0.0.1:${this.port}`;
    if (req.headers.host !== host) throw new RouterError('HOST_FORBIDDEN', 403);
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (this.phase !== 'running') throw new RouterError('GATEWAY_DRAINING', 503);
    if (url.pathname === '/oauth/callback') {
      if (req.method !== 'GET' || req.headers.origin) throw new RouterError('CALLBACK_FORBIDDEN', 403);
      const providerId = await this.credentials.complete(url.searchParams); this.routing.reset(providerId);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'" });
      res.end('AgentRouter 登录完成，可以关闭此页面。'); return;
    }
    if (req.headers.origin) throw new RouterError('ORIGIN_FORBIDDEN', 403);
    // Local liveness probe; inference routes still require the gateway token.
    if (url.pathname === '/health') {
      if (req.method !== 'GET') throw new RouterError('ROUTE_NOT_FOUND', 404);
      sendJson(res, 200, { status: 'ok' }); return;
    }
    const authorization = req.headers.authorization;
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : req.headers['x-api-key'];
    if (!this.accessToken || typeof supplied !== 'string' || !secretEqual(supplied, this.accessToken)) throw new RouterError('GATEWAY_UNAUTHORIZED', 401);
    const config = this.config!;
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const models = config.providers.filter(p => p.enabled && this.credentials.ready(p)).flatMap(p => exposedModels(p).map(m => ({ id: `${p.id}/${m}`, object: 'model', created: 0, owned_by: p.id })));
      for (const group of effectiveGroups(config)) if (group.members.some(m => models.some(item => item.id === m))) models.push({ id: `auto/${group.id}`, object: 'model', created: 0, owned_by: 'agent-router' });
      sendJson(res, 200, { object: 'list', data: models }); return;
    }
    const protocol = paths[url.pathname];
    if (!protocol || req.method !== 'POST' || url.search) throw new RouterError('ROUTE_NOT_FOUND', 404);
    if (this.active.size >= this.limits.maxConcurrent + this.limits.maxQueued) throw new RouterError('GATEWAY_BUSY', 429);
    const request = new AbortController(); this.active.add(request); const began = Date.now();
    const trace: RouterTrace = { id: randomUUID(), startedAt: new Date().toISOString(), protocol, status: 0, durationMs: 0, outcome: 'running', phase: 'body', attempts: [] };
    this.traces.unshift(trace); this.traces.length = Math.min(this.traces.length, 200);
    // pipeline destroys the downstream after an upstream error too; that is not client cancellation.
    let relayFailed = false;
    const cancel = () => { if (!res.writableFinished && !relayFailed) request.abort(new RouterError('REQUEST_CANCELLED', 499)); };
    req.once('aborted', cancel); res.once('close', cancel);
    const deadline = setTimeout(() => request.abort(new AttemptFailure('REQUEST_TIMEOUT', 504, 'cancelled', false)), this.limits.requestTimeoutMs); deadline.unref();
    let releaseGlobal: (() => void) | undefined;
    try {
      const body = object(await abortable(readJson(req), request.signal)); cancelled(request.signal);
      if (typeof body.model !== 'string') throw new RouterError('MODEL_REQUIRED');
      // Never retain arbitrary user text as a model label.
      const known = config.providers.some(p => exposedModels(p).some(m => `${p.id}/${m}` === body.model)) || effectiveGroups(config).some(g => `auto/${g.id}` === body.model);
      if (known) trace.model = body.model;
      const queuedAt = Date.now();
      try {
        const admitted = await this.global.acquire(request.signal, () => { trace.phase = 'global-queue'; }); releaseGlobal = admitted.release;
      } finally { trace.queuedMs = Date.now() - queuedAt; }
      cancelled(request.signal); trace.phase = 'planning';
      const header = req.headers['x-agent-router-session-id']; const session = typeof header === 'string' && /^[\w.-]{1,128}$/.test(header) ? header : undefined;
      const plan = this.routing.plan(config, body.model, protocol, p => this.credentials.ready(p), session); trace.affinity = plan.affinity; trace.strategy = plan.strategy; trace.decisions = plan.decisions;
      const nextAt = plan.decisions.flatMap(d => d.retryAt ? [d.retryAt - Date.now()] : []);
      let last: RouterError = new RouterError('NO_READY_PROVIDER_FOR_PROTOCOL', 503, nextAt.length ? Math.max(1, Math.min(...nextAt)) : undefined);
      for (const [index, candidate] of plan.candidates.entries()) {
        cancelled(request.signal);
        const { provider, model } = candidate;
        let lane = this.lanes.get(provider.id);
        if (!lane) { lane = new AdmissionQueue({ ...DEFAULT_PROVIDER_LIMITS, ...provider.limits }); this.lanes.set(provider.id, lane); }
        const at = Date.now(); const attempt: RouterAttempt = { target: candidate.target, status: 0, durationMs: 0, sent: false, committed: false }; trace.attempts.push(attempt);
        let release: (() => void) | undefined; let entered = false; let reply: TransportReply | undefined;
        const abort = new AbortController(); const propagate = () => abort.abort(request.signal.reason); request.signal.addEventListener('abort', propagate, { once: true });
        let first: ReturnType<typeof setTimeout> | undefined;
        try {
          trace.phase = 'provider-queue'; const slot = await lane.acquire(request.signal); release = slot.release;
          attempt.queuedMs = slot.queuedMs; trace.queuedMs += slot.queuedMs; cancelled(request.signal);
          if (!this.routing.enter(candidate)) { attempt.reason = this.routing.health(provider.id, model).reason; attempt.status = 503; continue; } entered = true;
          const upstreamBody = convertRequest({ ...body, model }, protocol, provider.protocol);
          const sent = Date.now(); attempt.sent = true; trace.phase = 'upstream';
          first = setTimeout(() => abort.abort(new AttemptFailure('FIRST_RESPONSE_TIMEOUT', 504, 'first-response', true)), this.limits.firstResponseTimeoutMs); first.unref();
          reply = await abortable(openTransport(this.credentials, provider, upstreamBody, abort.signal, this.port, session, index < plan.candidates.length - 1), abort.signal, late => late.dispose());
          cancelled(abort.signal); attempt.status = reply.status;
          if (reply.status < 200 || reply.status >= 300) throw responseFailure(reply.status, reply.headers['retry-after']);
          // Measure first upstream content, not the end of a non-streaming aggregation.
          // The prepared source also keeps its idle timeout while the converter collects it.
          const original = reply;
          const source = await prepareReply(original, abort.signal); cancelled(abort.signal);
          clearTimeout(first); first = undefined; attempt.responseStartMs = Date.now() - sent;
          const prepared: TransportReply = { ...original, body: source, dispose() { source.destroy(); original.dispose(); } };
          reply = convertReply(prepared, provider.protocol, protocol, body.model, body.stream === true, abort.signal);
          // Aggregated JSON is committed only after the complete upstream stream validates.
          const stream = reply === prepared ? source : await prepareReply(reply, abort.signal); cancelled(abort.signal);
          const headers: Record<string, string> = { 'content-type': reply.headers['content-type'], 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-agent-router-request-id': trace.id };
          if (reply.headers['content-encoding']) headers['content-encoding'] = reply.headers['content-encoding'];
          res.writeHead(reply.status, headers); res.flushHeaders(); attempt.committed = true; trace.phase = 'streaming'; trace.status = reply.status;
          stream.once('error', () => { relayFailed = true; });
          await pipeline(stream, res, { signal: abort.signal }); this.routing.success(candidate);
          if (config.sessionAffinity && effectiveGroups(config).some(g => `auto/${g.id}` === body.model)) this.routing.remember(candidate, body.model, session, protocol);
          trace.outcome = 'completed'; return;
        } catch (error) {
          if (attempt.queuedMs === undefined) { attempt.queuedMs = Date.now() - at; trace.queuedMs += attempt.queuedMs; }
          const failure = classify(request.signal.aborted ? request.signal.reason : abort.signal.aborted ? abort.signal.reason : error);
          attempt.failure = failure.kind; attempt.reason = failure.code; attempt.status = failure.status; last = failure;
          if (entered && failure.kind !== 'cancelled') this.routing.failure(candidate, failure);
          if (!attempt.sent && failure.code.startsWith('PROTOCOL_CONVERSION_UNSUPPORTED_') && index < plan.candidates.length - 1) continue;
          if (attempt.committed || !failure.retryable || request.signal.aborted || index === plan.candidates.length - 1) throw failure;
        } finally {
          if (first) clearTimeout(first); request.signal.removeEventListener('abort', propagate);
          abort.abort(); reply?.dispose(); if (entered) this.routing.leave(candidate); release?.(); attempt.durationMs = Date.now() - at;
        }
      }
      throw last;
    } catch (error) {
      const failure = classify(request.signal.aborted ? request.signal.reason : error);
      trace.outcome = failure.kind === 'cancelled' ? 'cancelled' : 'failed'; trace.status = failure.status; trace.reason = failure.code;
      throw failure;
    } finally {
      clearTimeout(deadline); releaseGlobal?.(); req.off('aborted', cancel); res.off('close', cancel);
      this.active.delete(request); if (!this.active.size) this.idle.forEach(resolve => resolve());
      trace.phase = 'done'; trace.durationMs = Date.now() - began;
      try { this.options.onTrace?.(structuredClone(trace)); } catch { /* History cannot fail inference. */ }
    }
  }
}

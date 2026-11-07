import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AgentIntegrations, effectiveGroups, exposedModels, publicModelId, gatewayModelName, type IntegrationTool, type IntegrationContext,
  withoutRouterProvider, sameSubscriptionAccount, canConvertProtocol, AgentSessions, SESSION_AGENTS, type SessionAgent, AgentGateway, ROUTER_PRESETS, RouterCredentialStore, RouterCredentials, RouterHistory, RouterRequestArchive, RouterError, discoverLocalLogins, emptyRouterConfig,
  pullProviderModelCatalog, loadRouterConfig, saveRouterConfig, validateRouterConfig, readJson, sendJson, secretEqual,
  type AgentRouterConfig,
} from '@juejin-opensource/jusage-core/agent-router';

/** Control stays on the host-key protected sidecar, separate from inference. */
export class DesktopAgentRouter {
  private config: AgentRouterConfig = emptyRouterConfig();
  private error: string | null = null;
  private busy = false;
  readonly gateway: AgentGateway;
  private history: RouterHistory;
  private archive: RouterRequestArchive;
  private store: RouterCredentialStore;
  private sessions: AgentSessions;
  private integrations: AgentIntegrations;
  private integrationTimer?: ReturnType<typeof setInterval>;
  private integrationRevision = '';
  private integrationError: string | null = null;
  private async desiredRunning(): Promise<boolean> {
    // An explicit launch override wins; otherwise restore the user's switch.
    if (process.env.TUD_AGENT_ROUTER_ENABLED !== undefined) return process.env.TUD_AGENT_ROUTER_ENABLED === '1';
    try {
      const raw = await readFile(join(this.dataDir, 'agent-router', 'enabled.json'), 'utf8');
      if (raw.length > 128) throw new Error();
      const state = JSON.parse(raw);
      if (state.version !== 1 || typeof state.enabled !== 'boolean') throw new Error();
      return state.enabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new RouterError('GATEWAY_STATE_UNREADABLE', 409);
    }
  }
  private async saveRunning(enabled: boolean): Promise<void> {
    const directory = join(this.dataDir, 'agent-router'); await mkdir(directory, { recursive: true });
    const path = join(directory, 'enabled.json'); const temp = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, JSON.stringify({ version: 1, enabled }) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
    catch { throw new RouterError('GATEWAY_STATE_WRITE_FAILED', 500); }
    finally { await unlink(temp).catch(() => {}); }
  }
  constructor(private dataDir: string, private hostKey: string, vaultKey?: Uint8Array, integrationEnvironment?: ConstructorParameters<typeof AgentIntegrations>[1]) {
    this.sessions = new AgentSessions(join(dataDir, 'agent-router', 'sessions'));
    this.history = new RouterHistory(join(dataDir, 'agent-router', 'history'));
    this.archive = new RouterRequestArchive(join(dataDir, 'agent-router', 'request-archive'));
    this.store = new RouterCredentialStore(join(dataDir, 'agent-router', 'credentials.enc'), vaultKey);
    this.integrations = new AgentIntegrations(this.store, integrationEnvironment ?? { home: process.env.USERPROFILE && process.platform === 'win32' ? process.env.USERPROFILE : homedir(), platform: process.platform, env: process.env, dataDir: join(dataDir, 'agent-router', 'integrations') });
    this.gateway = new AgentGateway(new RouterCredentials(process.env, Date.now, undefined, this.store), { onTrace: trace => this.history.append(trace), onArchive: record => this.archive.append(record), accessToken: () => this.store.error ? Promise.resolve(undefined) : this.store.gatewayToken() });
  }
  async init(): Promise<void> {
    await this.sessions.clear();
    await this.store.init();
    try { await this.integrations.init(); } catch { this.integrationError = 'INTEGRATION_STATE_INVALID'; }
    try { this.config = await loadRouterConfig(join(this.dataDir, 'agent-router', 'config.json')); }
    catch { this.error = 'ROUTER_CONFIG_UNREADABLE'; }
    if (!this.error) {
      try { if (await this.desiredRunning()) await this.gateway.start(this.config); }
      catch (error) { this.error = error instanceof RouterError && error.code === 'GATEWAY_STATE_UNREADABLE' ? error.code : 'GATEWAY_START_FAILED'; }
    }
    await this.syncIntegrations();
    this.integrationTimer = setInterval(() => { if (!this.busy) void this.syncIntegrations().catch(() => {}); }, 5000);
    this.integrationTimer.unref();
  }
  private integrationContext(): IntegrationContext {
    const status = this.gateway.status();
    const models = this.config.providers.filter(p => p.enabled && this.gateway.credentials.ready(p)).flatMap(p => exposedModels(p).map(model => ({ id: publicModelId(p, model), name: gatewayModelName(p.preset, model), provider: p.name, legacyId: p.id + '/' + model })));
    for (const group of effectiveGroups(this.config)) if (group.members.some(id => models.some(m => m.legacyId === id))) models.push({ id: 'auto/' + group.id, name: group.id, provider: '自动路由', legacyId: 'auto/' + group.id });
    return { running: status.running, baseUrl: status.baseUrl, token: status.running ? this.gateway.token() : '', models };
  }
  private async syncIntegrations() {
    if (this.integrationError || this.store.error) return;
    const context = this.integrationContext(); const revision = JSON.stringify(context);
    if (revision === this.integrationRevision) return;
    this.integrationRevision = revision; await this.integrations.sync(context);
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const root = '/functions/tud-agent-router';
    if (url.pathname !== root && !url.pathname.startsWith(root + '/')) return false;
    const supplied = req.headers['x-tud-host-key'];
    if (!this.hostKey || typeof supplied !== 'string' || !secretEqual(supplied, this.hostKey) || req.headers.origin) {
      sendJson(res, 403, { success: false, message: 'FORBIDDEN', data: null }); return true;
    }
    const mutation = req.method !== 'GET' && !['/subscription/methods', '/subscription/usage', '/models'].some(path => url.pathname === root + path);
    if (mutation && this.busy) { sendJson(res, 409, { success: false, message: 'ROUTER_BUSY', data: null }); return true; }
    if (mutation) this.busy = true;
    try {
      let data: unknown;
      if (req.method === 'GET' && url.pathname === root) {
        data = { presets: ROUTER_PRESETS, config: this.config, ...this.gateway.status(), error: this.error, credentialError: this.store.error, history: this.history.status(), archive: this.archive.status(),
          providers: this.config.providers.map(p => ({ id: p.id, saved: Boolean(this.store.get(p)), ready: this.gateway.credentials.ready(p),
            ...(p.auth.kind === 'subscription' ? { subscription: this.gateway.credentials.subscriptions.state(p) } : {}) })),
          localLogins: await discoverLocalLogins() };
      } else if (url.pathname === root + '/agents/integrations' || url.pathname.startsWith(root + '/agents/integrations/')) {
        if (this.integrationError) throw new RouterError(this.integrationError, 409);
        const id = url.pathname.slice((root + '/agents/integrations/').length) as IntegrationTool;
        if (req.method === 'GET' && url.pathname === root + '/agents/integrations') data = await this.integrations.list(this.integrationContext(), url.searchParams.get('refresh') === '1');
        else if (req.method === 'PUT' && id) {
          if (this.store.error) throw new RouterError(this.store.error, 503);
          await this.integrations.update(id, await readJson(req, 256 * 1024), this.integrationContext());
          data = await this.integrations.list(this.integrationContext());
        } else if (req.method === 'DELETE' && id) {
          await this.integrations.remove(id); data = await this.integrations.list(this.integrationContext());
        } else throw new RouterError('ROUTE_NOT_FOUND', 404);
      } else if (req.method === 'GET' && url.pathname === root + '/archive') {
        const day = url.searchParams.get('day'), id = url.searchParams.get('id'), before = url.searchParams.get('before');
        if ((day === null) !== (id === null)) throw new RouterError('INVALID_ARCHIVE_ID');
        data = day && id ? await this.archive.read(day, id) : await this.archive.list(before ?? undefined);
      } else if (req.method === 'GET' && url.pathname === root + '/history') {
        const day = url.searchParams.get('day'); const before = url.searchParams.get('before'); const after = url.searchParams.get('after');
        if ((before !== null && after !== null) || (!day && (before !== null || after !== null))) throw new RouterError('INVALID_HISTORY_CURSOR');
        data = day ? after !== null ? await this.history.changes(day, after) : await this.history.page(day, before === null ? undefined : Number(before)) : { dates: await this.history.dates() };
      } else if (req.method === 'PUT' && url.pathname === root + '/config') {
        const config = validateRouterConfig(await readJson(req, 256 * 1024));
        const persist = (next: AgentRouterConfig) => saveRouterConfig(join(this.dataDir, 'agent-router', 'config.json'), next);
        if (this.gateway.status().running) await this.gateway.addProviders(config, persist);
        else { await persist(config); this.gateway.credentials.clear(); }
        const previous = this.config;
        this.config = config; this.error = null;
        for (const provider of previous.providers) {
          const next = config.providers.find(p => p.id === provider.id);
          if ((!next || JSON.stringify([next.baseUrl, next.protocol, next.auth]) !== JSON.stringify([provider.baseUrl, provider.protocol, provider.auth])) && this.store.get(provider)) await this.gateway.credentials.logout(provider);
        }
        data = { saved: true };
      } else if (req.method === 'POST' && url.pathname === root + '/agents/session') {
        const body = await readJson(req, 4096) as { agent: SessionAgent; model: string };
        if (!body || !Object.hasOwn(SESSION_AGENTS, body.agent)) throw new RouterError('AGENT_SESSION_UNKNOWN');
        const status = this.gateway.status();
        if (status.phase !== 'running' || !status.baseUrl) throw new RouterError('GATEWAY_STOPPED', 409);
        const provider = this.config.providers.find(p => p.enabled && canConvertProtocol(SESSION_AGENTS[body.agent], p.protocol) && p.models.some(m => p.id + '/' + m === body.model));
        if (!provider || !this.gateway.credentials.ready(provider)) throw new RouterError('AGENT_MODEL_UNAVAILABLE', 409);
        data = await this.sessions.create(body.agent, status.baseUrl, this.gateway.token(), body.model);
      } else if (req.method === 'POST' && url.pathname === root + '/start') {
        if (this.error === 'ROUTER_CONFIG_UNREADABLE') throw new RouterError(this.error, 409);
        const wasRunning = this.gateway.status().running;
        try { await this.gateway.start(this.config); } catch { throw new RouterError('GATEWAY_START_FAILED', 500); }
        try { await this.saveRunning(true); } catch (error) { if (!wasRunning) await this.gateway.stop(); throw error; }
        this.error = null; data = this.gateway.status();
      } else if (req.method === 'POST' && url.pathname === root + '/stop') {
        await this.saveRunning(false);
        try { await this.sessions.clear(); } finally { await this.gateway.stop(); }
        data = this.gateway.status();
      } else if (req.method === 'GET' && url.pathname === root + '/token') {
        if (!this.gateway.status().running) throw new RouterError('GATEWAY_STOPPED', 409);
        data = { token: this.gateway.token() };
      } else if (req.method === 'POST' && (url.pathname === root + '/credentials/logout' || url.pathname === root + '/credentials/import')) {
        const body = await readJson(req, 32 * 1024) as { providerId?: string; key?: string };
        const provider = this.config.providers.find(p => p.id === body?.providerId);
        if (!provider) throw new RouterError('PROVIDER_NOT_FOUND', 404);
        if (url.pathname.endsWith('/logout')) await this.gateway.credentials.logout(provider);
        else await this.gateway.credentials.importKey(provider, typeof body.key === 'string' ? body.key.trim() : '');
        this.gateway.resetHealth(provider.id); data = { saved: true };
      } else if (req.method === 'POST' && url.pathname === root + '/token/rotate') {
        await this.sessions.clear();
        const token = await this.store.gatewayToken(true);
        this.gateway.rotateToken(token); data = { rotated: true };
      } else if (req.method === 'POST' && url.pathname === root + '/models') {
        const body = await readJson(req, 32 * 1024) as { providerId?: string; provider?: unknown };
        const provider = body.provider !== undefined
          ? validateRouterConfig({ ...emptyRouterConfig(), providers: [body.provider] }).providers[0]
          : this.config.providers.find(p => p.id === body.providerId && p.enabled);
        if (!provider) throw new RouterError('PROVIDER_NOT_FOUND', 404);
        if (body.provider !== undefined && provider.auth.kind !== 'env') throw new RouterError('SAVE_AND_LOGIN_BEFORE_MODELS', 409);
        data = provider.auth.kind === 'subscription'
          ? await this.gateway.credentials.subscriptions.modelCatalog(provider)
          : await pullProviderModelCatalog(this.gateway.credentials, provider, this.gateway.status().port);
      } else if (req.method === 'POST' && url.pathname === root + '/providers/remove') {
        const body = await readJson(req, 4096) as { providerId?: string };
        const provider = this.config.providers.find(p => p.id === body?.providerId);
        if (!provider) throw new RouterError('PROVIDER_NOT_FOUND', 404);
        const persist = (config: AgentRouterConfig) => saveRouterConfig(join(this.dataDir, 'agent-router', 'config.json'), config);
        if (this.gateway.status().running) this.config = await this.gateway.removeProvider(provider.id, persist, true);
        else { const next = withoutRouterProvider(this.config, provider.id); await persist(next); this.config = next; }
        await this.gateway.credentials.subscriptions.cancel(provider.id);
        await this.gateway.credentials.logout(provider);
        this.gateway.resetHealth(provider.id);
        data = { removed: true };
      } else if (req.method === 'POST' && url.pathname === root + '/subscription/deduplicate') {
        const body = await readJson(req, 4096) as { providerId?: string };
        const index = this.config.providers.findIndex(p => p.id === body?.providerId);
        if (index < 0) throw new RouterError('PROVIDER_NOT_FOUND', 404);
        const provider = this.config.providers[index];
        const credential = this.store.get(provider);
        const existing = credential && this.config.providers.slice(0, index).find(other => {
          const saved = this.store.get(other);
          return saved && this.gateway.credentials.ready(other) && sameSubscriptionAccount(provider, credential, other, saved);
        });
        if (existing) {
          const persist = (config: AgentRouterConfig) => saveRouterConfig(join(this.dataDir, 'agent-router', 'config.json'), config);
          if (this.gateway.status().running) this.config = await this.gateway.removeProvider(provider.id, persist);
          else {
            const next = validateRouterConfig({ ...this.config, providers: this.config.providers.filter(p => p.id !== provider.id) });
            await persist(next); this.config = next;
          }
          await this.gateway.credentials.subscriptions.cancel(provider.id);
          await this.store.delete(provider);
        }
        data = { duplicate: Boolean(existing), providerId: existing ? existing.id : provider.id };
      } else if (req.method === 'POST' && url.pathname === root + '/routing/reset') {
        const body = await readJson(req, 4096) as { providerId?: string };
        if (!this.config.providers.some(p => p.id === body?.providerId)) throw new RouterError('PROVIDER_NOT_FOUND', 404);
        this.gateway.resetHealth(body.providerId!); data = { reset: true };
      } else if (req.method === 'POST' && (url.pathname === root + '/subscription/methods' || url.pathname === root + '/subscription/complete' || url.pathname === root + '/subscription/login' || url.pathname === root + '/subscription/models' || url.pathname === root + '/subscription/usage' || url.pathname === root + '/subscription/cancel')) {
        const body = await readJson(req, 32 * 1024) as { providerId?: string; methodIndex?: number; inputs?: Record<string, string>; code?: string };
        const provider = this.config.providers.find(p => p.id === body?.providerId && (p.enabled || url.pathname.endsWith('/usage')) && p.auth.kind === 'subscription');
        if (!provider) throw new RouterError('PROVIDER_NOT_FOUND', 404);
        if (body.inputs !== undefined && (!body.inputs || typeof body.inputs !== 'object' || Array.isArray(body.inputs) || Object.keys(body.inputs).length > 32 || Object.entries(body.inputs).some(([key, value]) => key.length > 80 || typeof value !== 'string' || value.length > 16384))) throw new RouterError('SUBSCRIPTION_INPUT_INVALID');
        if (body.methodIndex !== undefined && (!Number.isInteger(body.methodIndex) || body.methodIndex < 0 || body.methodIndex > 32)) throw new RouterError('SUBSCRIPTION_INPUT_INVALID');
        if (url.pathname.endsWith('/methods')) data = await this.gateway.credentials.subscriptions.methods(provider, body.inputs);
        else if (url.pathname.endsWith('/usage')) data = await this.gateway.credentials.subscriptions.usage(provider);
        else if (url.pathname.endsWith('/cancel')) { await this.gateway.credentials.subscriptions.cancel(provider.id); data = { cancelled: true }; }
        else {
          if (!this.gateway.status().running) throw new RouterError('START_GATEWAY_BEFORE_LOGIN', 409);
          if (url.pathname.endsWith('/login')) {
            data = await this.gateway.credentials.subscriptions.begin(provider, { methodIndex: body.methodIndex, inputs: body.inputs });
            this.gateway.resetHealth(provider.id);
          } else if (url.pathname.endsWith('/complete')) {
            if (typeof body.code !== 'string' || !body.code.trim() || body.code.length > 8192) throw new RouterError('SUBSCRIPTION_INPUT_INVALID');
            data = await this.gateway.credentials.subscriptions.complete(provider, body.code);
          } else data = { models: await this.gateway.credentials.subscriptions.models(provider) };
        }
      } else if (req.method === 'POST' && url.pathname === root + '/oauth/start') {
        const body = await readJson(req, 4096) as { providerId?: string };
        const provider = this.config.providers.find(p => p.id === body?.providerId && p.enabled);
        if (!provider) throw new RouterError('PROVIDER_NOT_FOUND', 404);
        const { port, running } = this.gateway.status();
        if (!running) throw new RouterError('START_GATEWAY_BEFORE_LOGIN', 409);
        data = { url: this.gateway.credentials.begin(provider, `http://127.0.0.1:${port}/oauth/callback`) };
      } else throw new RouterError('ROUTE_NOT_FOUND', 404);
      if (mutation) await this.syncIntegrations();
      sendJson(res, 200, { success: true, message: 'ok', data });
    } catch (error) {
      sendJson(res, error instanceof RouterError ? error.status : 500, { success: false, message: error instanceof RouterError ? error.code : 'AGENT_ROUTER_FAILED', data: null });
    } finally { if (mutation) this.busy = false; }
    return true;
  }
  async close(): Promise<void> {
    if (this.integrationTimer) clearInterval(this.integrationTimer);
    await this.integrations.flush();
    try { await this.sessions.clear(); } finally { await this.gateway.stop(); await this.history.flush(); await this.archive.flush(); await this.store.flush(); }
  }
}

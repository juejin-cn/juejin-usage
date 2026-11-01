import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { routerPreset, subscriptionMethods, type SubscriptionId, type SubscriptionMethod } from './presets.js';
import type { QueueLimits, GatewayLimits } from './limits.js';
export * from './limits.js';

export type Protocol = 'chat' | 'responses' | 'messages';
export type ProviderAuth =
  | { kind: 'env'; variable: string }
  | { kind: 'subscription'; provider: SubscriptionId; method: SubscriptionMethod; variable?: string }
  | { kind: 'oauth'; clientId: string; authorizeUrl: string; tokenUrl: string; scopes: string[] };
export interface RouterProvider {
  id: string;
  preset?: string;
  name: string;
  enabled: boolean;
  protocol: Protocol;
  baseUrl: string;
  models: string[];
  excludedModels?: string[];
  auth: ProviderAuth;
  limits?: Partial<QueueLimits>;
}
export interface RouterGroup { id: string; members: string[]; strategy?: 'ordered' | 'round-robin' }
export interface AgentRouterConfig {
  version: 1;
  port: number;
  providers: RouterProvider[];
  groups: RouterGroup[];
  gateway?: Partial<GatewayLimits>;
  autoGroups?: boolean;
  sessionAffinity?: boolean;
}
export const emptyRouterConfig = (): AgentRouterConfig => ({ version: 1, port: 18453, providers: [], groups: [] });

export class RouterError extends Error {
  constructor(public readonly code: string, public readonly status = 400, public readonly retryAfterMs?: number) { super(code); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouterError('INVALID_OBJECT');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\x00]/.test(value)) throw new RouterError('INVALID_STRING');
  return value.trim();
}
function id(value: unknown): string {
  const result = string(value, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) throw new RouterError('INVALID_ID');
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new RouterError('INVALID_ARRAY');
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RouterError('UNKNOWN_FIELD');
}
function limits(value: unknown, gateway: boolean): Partial<GatewayLimits> {
  const input = object(value); const out: Record<string, number> = {};
  const bounds: Record<string, [number, number]> = { maxConcurrent: [1, gateway ? 32 : 16], maxQueued: [0, 32], queueTimeoutMs: [1, 60000],
    ...(gateway ? { firstResponseTimeoutMs: [1, 120000] as [number, number], requestTimeoutMs: [1, 600000] as [number, number], drainTimeoutMs: [0, 3000] as [number, number] } : {}) };
  keys(input, Object.keys(bounds));
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || Number(value) < bounds[key][0] || Number(value) > bounds[key][1]) throw new RouterError('INVALID_LIMITS');
    out[key] = Number(value);
  }
  if (gateway && (out.maxConcurrent ?? 16) + (out.maxQueued ?? 20) > 48) throw new RouterError('INVALID_LIMITS');
  return out;
}
/** HTTP is only permitted for explicit loopback development upstreams. */
export function endpoint(value: unknown): string {
  let url: URL;
  try { url = new URL(string(value, 2048)); } catch { throw new RouterError('INVALID_ENDPOINT'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new RouterError('INVALID_ENDPOINT');
  }
  return url.href.replace(/\/+$/, '');
}
export function validateRouterConfig(value: unknown): AgentRouterConfig {
  const input = object(value);
  keys(input, ['version', 'port', 'providers', 'groups', 'gateway', 'autoGroups', 'sessionAffinity']);
  if (input.sessionAffinity !== undefined && typeof input.sessionAffinity !== 'boolean') throw new RouterError('INVALID_CONFIG');
  if (input.autoGroups !== undefined && typeof input.autoGroups !== 'boolean') throw new RouterError('INVALID_CONFIG');
  if (input.version !== 1 || !Number.isInteger(input.port) || Number(input.port) < 0 || Number(input.port) > 65535) throw new RouterError('INVALID_CONFIG');
  const providers = array(input.providers, 64).map(value => {
    const p = object(value); keys(p, ['id', 'name', 'enabled', 'protocol', 'baseUrl', 'models', 'excludedModels', 'auth', 'preset', 'limits']);
    if (!['chat', 'responses', 'messages'].includes(String(p.protocol)) || typeof p.enabled !== 'boolean') throw new RouterError('INVALID_PROVIDER');
    const a = object(p.auth);
    let auth: ProviderAuth;
    if (a.kind === 'env') {
      keys(a, ['kind', 'variable']);
      const variable = string(a.variable);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new RouterError('INVALID_ENV_NAME');
      auth = { kind: 'env', variable };
    } else if (a.kind === 'subscription') {
      keys(a, ['kind', 'provider', 'method', 'variable']);
      const preset = routerPreset(String(a.provider));
      const methods = subscriptionMethods(String(a.provider));
      if (!preset?.subscription || !methods.some(method => method === a.method) || !preset.endpoints[p.protocol as Protocol] || p.baseUrl !== preset.endpoints[p.protocol as Protocol] || p.preset !== preset.id) throw new RouterError('INVALID_SUBSCRIPTION');
      if (['env', 'pat-env'].includes(String(a.method))) {
        if (typeof a.variable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.variable)) throw new RouterError('INVALID_ENV_NAME');
      } else if (a.variable !== undefined) throw new RouterError('INVALID_SUBSCRIPTION');
      auth = { kind: 'subscription', provider: preset.subscription, method: a.method as SubscriptionMethod, ...(a.variable !== undefined ? { variable: String(a.variable) } : {}) };
    } else if (a.kind === 'oauth') {
      keys(a, ['kind', 'clientId', 'authorizeUrl', 'tokenUrl', 'scopes']);
      auth = { kind: 'oauth', clientId: string(a.clientId), authorizeUrl: endpoint(a.authorizeUrl), tokenUrl: endpoint(a.tokenUrl), scopes: array(a.scopes, 32).map(s => string(s)) };
    } else throw new RouterError('UNSUPPORTED_AUTH');
    if (p.preset !== undefined) {
      const preset = routerPreset(String(p.preset));
      if (!preset || preset.endpoints[p.protocol as Protocol] !== p.baseUrl || (preset.subscription ? auth.kind !== 'subscription' : auth.kind !== 'env')) throw new RouterError('INVALID_PRESET');
    }
    return { id: id(p.id), ...(p.preset !== undefined ? { preset: String(p.preset) } : {}), ...(p.limits !== undefined ? { limits: limits(p.limits, false) } : {}), name: string(p.name), enabled: p.enabled, protocol: p.protocol as Protocol, baseUrl: endpoint(p.baseUrl), models: array(p.models, 128).map(m => string(m)), ...(p.excludedModels !== undefined ? { excludedModels: array(p.excludedModels, 128).map(m => string(m)) } : {}), auth };
  });
  const providerIds = new Set(providers.map(p => p.id));
  if (providerIds.has('auto')) throw new RouterError('RESERVED_PROVIDER_ID');
  if (providerIds.size !== providers.length) throw new RouterError('DUPLICATE_PROVIDER');
  // Subscription catalogs are populated after authorization. Until then an
  // empty account contributes no models or routes to the running gateway.
  if (providers.some(p => (!p.models.length && p.auth.kind !== 'subscription') || new Set(p.models).size !== p.models.length)) throw new RouterError('INVALID_MODELS');
  if (providers.some(p => p.excludedModels && (new Set(p.excludedModels).size !== p.excludedModels.length || p.excludedModels.some(m => !p.models.includes(m))))) throw new RouterError('INVALID_MODELS');
  const known = new Set(providers.flatMap(p => p.models.map(m => `${p.id}/${m}`)));
  const groups = array(input.groups, 64).map(value => {
    const g = object(value); keys(g, ['id', 'members', 'strategy']);
    if (g.strategy !== undefined && !['ordered', 'round-robin'].includes(String(g.strategy))) throw new RouterError('INVALID_STRATEGY');
    const members = array(g.members, 16).map(m => string(m));
    if (!members.length || members.some(m => !known.has(m)) || new Set(members).size !== members.length) throw new RouterError('INVALID_MEMBERS');
    return { id: id(g.id), members, ...(g.strategy !== undefined ? { strategy: g.strategy as 'ordered' | 'round-robin' } : {}) };
  });
  if (new Set(groups.map(g => g.id)).size !== groups.length) throw new RouterError('DUPLICATE_GROUP');
  return { version: 1, port: Number(input.port), providers, groups, ...(input.sessionAffinity !== undefined ? { sessionAffinity: input.sessionAffinity as boolean } : {}), ...(input.autoGroups !== undefined ? { autoGroups: input.autoGroups as boolean } : {}), ...(input.gateway !== undefined ? { gateway: limits(input.gateway, true) } : {}) };
}
export async function loadRouterConfig(path: string): Promise<AgentRouterConfig> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRouterConfig(); throw error; }
  try { return validateRouterConfig(JSON.parse(raw)); }
  catch { throw new RouterError('ROUTER_CONFIG_UNREADABLE'); }
}

export async function saveRouterConfig(path: string, config: AgentRouterConfig): Promise<void> {
  const validated = validateRouterConfig(config);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
}

/** Keep the catalog intact while excluding deselected models from public routing. */
export function exposedModels(provider: RouterProvider): string[] {
  return provider.models.filter(model => !provider.excludedModels?.includes(model));
}

/** Remove an account and its route members, dropping groups left with no targets. */
export function withoutRouterProvider(config: AgentRouterConfig, providerId: string): AgentRouterConfig {
  return validateRouterConfig({ ...config,
    providers: config.providers.filter(provider => provider.id !== providerId),
    groups: config.groups.map(group => ({ ...group, members: group.members.filter(member => !member.startsWith(providerId + '/')) })).filter(group => group.members.length),
  });
}

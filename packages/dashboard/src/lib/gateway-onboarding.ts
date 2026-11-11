import { preferredClientProtocol } from '@juejin-opensource/jusage-core/agent-router/presets';
import type { AgentRouterConfig, Protocol, RouterProvider } from '@juejin-opensource/jusage-core/agent-router';
import type { AgentRouterSnapshot } from './agent-router';

export const CUSTOM_PROVIDER_PROTOCOLS: readonly { id: Protocol; label: string }[] = [
  { id: 'chat', label: 'OpenAI 兼容' },
  { id: 'responses', label: 'OpenAI Responses' },
  { id: 'messages', label: 'Anthropic 兼容' },
  { id: 'gemini', label: 'Gemini 兼容' },
];

export interface CustomGatewayProviderInput {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
  excludedModels?: string[];
}

export function isCustomGatewayProvider(provider: RouterProvider): boolean {
  return provider.auth.kind === 'env' && provider.preset === undefined;
}

export function normalizeCustomBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Stored API keys are bound to id + Base URL + protocol; changing either needs a new key. */
export function customCredentialChanged(provider: RouterProvider, input: Pick<CustomGatewayProviderInput, 'protocol' | 'baseUrl'>): boolean {
  return provider.protocol !== input.protocol || provider.baseUrl !== normalizeCustomBaseUrl(input.baseUrl);
}

function customProviderFields(input: CustomGatewayProviderInput): Pick<RouterProvider, 'name' | 'protocol' | 'baseUrl' | 'models' | 'excludedModels'> {
  const name = input.name.trim();
  if (!name) throw new Error('请填写供应商名称。');
  if (!input.baseUrl.trim()) throw new Error('请填写 Base URL。');
  if (!CUSTOM_PROVIDER_PROTOCOLS.some(item => item.id === input.protocol)) throw new Error('不支持的协议。');
  const models = [...new Set(input.models.map(model => model.trim()).filter(Boolean))];
  const excluded = [...new Set(input.excludedModels ?? [])].filter(model => models.includes(model));
  if (models.length && excluded.length === models.length) throw new Error('请至少启用一个模型。');
  return { name, protocol: input.protocol, baseUrl: normalizeCustomBaseUrl(input.baseUrl), models, excludedModels: excluded.length ? excluded : undefined };
}

/** Build a custom API-key provider; models may be filled after import. */
export function makeCustomGatewayProvider(input: CustomGatewayProviderInput): RouterProvider {
  if (!input.apiKey.trim()) throw new Error('请粘贴 API 密钥。');
  const { excludedModels, ...fields } = customProviderFields(input);
  const slug = fields.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'custom';
  return {
    id: `custom-${slug}-${crypto.randomUUID().slice(0, 8)}`,
    enabled: true,
    ...fields,
    ...(excludedModels ? { excludedModels } : {}),
    auth: { kind: 'env', variable: 'JUSAGE_CUSTOM_API_KEY' },
  };
}

/** Same id and auth as the saved provider so the host resolves its stored key when the binding is unchanged. */
export function draftCustomGatewayProvider(input: CustomGatewayProviderInput, existing?: RouterProvider): RouterProvider {
  if (!existing) return makeCustomGatewayProvider({ ...input, name: input.name.trim() || 'Custom', models: [], excludedModels: [] });
  const { excludedModels: _saved, ...base } = existing;
  const { excludedModels: _draft, ...fields } = customProviderFields({ ...input, name: input.name.trim() || existing.name, models: [], excludedModels: [] });
  return { ...base, ...fields };
}

type Snapshot = Pick<AgentRouterSnapshot, 'config' | 'phase' | 'error' | 'credentialError' | 'presets'>;
interface ConnectionActions {
  snapshot: () => Promise<Snapshot>;
  save: (config: AgentRouterConfig) => Promise<unknown>;
  start: () => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  login: (id: string) => Promise<{ url: string }>;
  openExternal: (url: string) => Promise<void>;
  onCreated: (provider: RouterProvider) => void;
  onAuthorization: (id: string, url: string) => void;
}

type CustomConnectionActions = {
  snapshot: () => Promise<Snapshot>;
  save: (config: AgentRouterConfig) => Promise<unknown>;
  start: () => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  importKey: (id: string, key: string) => Promise<unknown>;
  pullModels: (providerId: string) => Promise<{ models: string[] }>;
  onCreated: (provider: RouterProvider) => void;
};

/** Save a custom API-key channel, import the key, then fill models when needed. */
export async function connectCustomGatewayProvider(input: CustomGatewayProviderInput, actions: CustomConnectionActions): Promise<RouterProvider> {
  const current = await actions.snapshot();
  if (current.error || current.credentialError) throw new Error('网关或安全存储不可用，请恢复后重试。');
  if (current.phase !== 'running' && current.phase !== 'stopped') throw new Error('网关正在切换状态，请稍后重试。');
  const provider = makeCustomGatewayProvider(input);
  await actions.save({ ...current.config, providers: [...current.config.providers, provider] });
  actions.onCreated(provider);
  try {
    if (current.phase === 'stopped') await actions.start();
    await actions.importKey(provider.id, input.apiKey.trim());
    if (!provider.models.length) {
      const catalog = await actions.pullModels(provider.id);
      const models = catalog.models.slice(0, 128);
      if (!models.length) throw new Error('保存成功，但当前协议暂无可用模型，请手动填写模型 ID。');
      const next = await actions.snapshot();
      await actions.save({
        ...next.config,
        providers: next.config.providers.map(item => item.id === provider.id ? { ...item, models } : item),
      });
      provider.models = models;
    }
  } catch (error) {
    await actions.remove(provider.id);
    throw error;
  }
  return provider;
}

type CustomUpdateActions = Omit<CustomConnectionActions, 'remove' | 'onCreated'>;

/** Edit a custom channel in place; restores the previous entry if the key or catalog step fails. */
export async function updateCustomGatewayProvider(existing: RouterProvider, input: CustomGatewayProviderInput, actions: CustomUpdateActions): Promise<RouterProvider> {
  const current = await actions.snapshot();
  if (current.error || current.credentialError) throw new Error('网关或安全存储不可用，请恢复后重试。');
  if (current.phase !== 'running' && current.phase !== 'stopped') throw new Error('网关正在切换状态，请稍后重试。');
  const previous = current.config.providers.find(item => item.id === existing.id);
  if (!previous) throw new Error('该供应商已被删除。');
  const key = input.apiKey.trim();
  if (!key && customCredentialChanged(previous, input)) throw new Error('修改了 Base URL 或协议，请重新填写 API 密钥。');
  const { excludedModels: _previousExcluded, ...base } = previous;
  const { excludedModels, ...fields } = customProviderFields(input);
  const provider: RouterProvider = { ...base, ...fields, ...(excludedModels ? { excludedModels } : {}) };
  const replace = (config: AgentRouterConfig, value: RouterProvider) => ({ ...config, providers: config.providers.map(item => item.id === value.id ? value : item) });
  await actions.save(replace(current.config, provider));
  try {
    if (key) await actions.importKey(provider.id, key);
    if (!provider.models.length) {
      if (current.phase === 'stopped') await actions.start();
      const models = (await actions.pullModels(provider.id)).models.slice(0, 128);
      if (!models.length) throw new Error('当前协议暂无可用模型，请手动填写模型 ID。');
      provider.models = models;
      await actions.save(replace((await actions.snapshot()).config, provider));
    }
  } catch (error) {
    await actions.save(replace((await actions.snapshot()).config, previous));
    throw error;
  }
  return provider;
}

/** Register for authorization; roll back if starting the login fails. */
export async function connectGatewayTool(presetId: string, actions: ConnectionActions): Promise<RouterProvider> {
  const current = await actions.snapshot();
  if (!current.presets) throw new Error('请重启应用以加载新的工具登录功能。');
  const supported = current.presets.find(p => p.id === presetId);
  if (!supported) throw new Error('当前网关尚不支持此工具，请重启或更新应用后重试。');
  if (!supported.subscription) throw new Error('此工具需要配置 API Key。');
  if (current.error || current.credentialError) throw new Error('网关或安全存储不可用，请恢复后重试。');
  if (current.phase !== 'running' && current.phase !== 'stopped') throw new Error('网关正在切换状态，请稍后重试。');
  const protocol = preferredClientProtocol(Object.keys(supported.endpoints) as Protocol[]);
  const provider: RouterProvider = {
    preset: supported.id, enabled: true, protocol,
    auth: { kind: 'subscription', provider: supported.subscription, method: 'browser' },
    baseUrl: supported.endpoints[protocol]!,
    models: [...supported.models],
    id: `${presetId}-${crypto.randomUUID()}`,
    name: supported.name,
  };
  await actions.save({ ...current.config, providers: [...current.config.providers, provider] });
  actions.onCreated(provider);
  let url: string;
  try {
    if (current.phase === 'stopped') await actions.start();
    ({ url } = await actions.login(provider.id));
    if (url && new URL(url).protocol !== 'https:' && !(new URL(url).protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))) throw new Error('授权链接无效，请重试登录。');
  } catch (error) {
    await actions.remove(provider.id);
    throw error;
  }
  if (url) {
    actions.onAuthorization(provider.id, url);
    await actions.openExternal(url);
  }
  return provider;
}

/** Hide the numbered suffix generated by older versions. */
export function gatewayToolName(provider: Pick<RouterProvider, 'name'>): string {
  return provider.name.replace(/ · 账号 \d+$/, '');
}

/** Only newly added accounts belong to this transaction; existing accounts are never removed. */
export function authorizationAccount(isNew: boolean, actions: { restore: () => Promise<unknown>; remove: () => Promise<unknown> }) {
  let present = true;
  let committed = !isNew;
  let pending = Promise.resolve();
  function enqueue(action: () => Promise<void>) {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  }
  return {
    ensure: () => enqueue(async () => {
      if (!committed && !present) { await actions.restore(); present = true; }
    }),
    rollback: () => enqueue(async () => {
      if (!committed && present) { await actions.remove(); present = false; }
    }),
    commit: () => { committed = true; },
  };
}

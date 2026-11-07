export { gatewayModelName } from './model-names.js';
import { CHANNEL_CATALOG, SUBSCRIPTION_IDS } from './channel-catalog.js';
export { CHANNEL_CATALOG } from './channel-catalog.js';
import type { Protocol, RouterProvider } from './config.js';
import { preferredClientProtocol } from './protocol-preference.js';
export { preferredClientProtocol } from './protocol-preference.js';

export type SubscriptionId = typeof SUBSCRIPTION_IDS[number];
export type SubscriptionMethod = 'browser' | 'desktop' | 'env' | 'pat-env';
export interface RouterPreset {
  id: string; name: string; subscription?: SubscriptionId; variable?: string;
  endpoints: Partial<Record<Protocol, string>>; models: string[]; icon?: string;
}
/** Explicit products: never silently change a Coding Plan into pay-as-you-go. */
export const ROUTER_PRESETS: RouterPreset[] = [
  { id: 'deepseek-api', name: 'DeepSeek · API', variable: 'DEEPSEEK_API_KEY', endpoints: { chat: 'https://api.deepseek.com' }, models: ['deepseek-flash', 'deepseek-v4-pro'] },
  { id: 'siliconflow-cn-api', name: '硅基流动国内 · API', variable: 'SILICONFLOW_API_KEY', endpoints: { chat: 'https://api.siliconflow.cn/v1' }, models: ['deepseek-ai/DeepSeek-V4-Flash'] },
  { id: 'glm-cn-coding', name: 'GLM 国内 · Coding Plan', variable: 'GLM_API_KEY', endpoints: { chat: 'https://open.bigmodel.cn/api/coding/paas/v4', responses: 'https://open.bigmodel.cn/api/v1', messages: 'https://open.bigmodel.cn/api/anthropic/v1' }, models: ['glm-5.3'] },
  { id: 'glm-global-coding', name: 'GLM 国际 · Coding Plan', variable: 'ZAI_API_KEY', endpoints: { chat: 'https://api.z.ai/api/coding/paas/v4', responses: 'https://api.z.ai/api/v1', messages: 'https://api.z.ai/api/anthropic/v1' }, models: ['glm-5.3'] },
  { id: 'glm-cn-api', name: 'GLM 国内 · 按量 API', variable: 'GLM_API_KEY', endpoints: { chat: 'https://open.bigmodel.cn/api/paas/v4' }, models: ['glm-5.3'] },
  { id: 'glm-global-api', name: 'GLM 国际 · 按量 API', variable: 'ZAI_API_KEY', endpoints: { chat: 'https://api.z.ai/api/paas/v4' }, models: ['glm-5.3'] },
];
for (const channel of CHANNEL_CATALOG) {
  // Merge the supported subscription catalog with explicit API presets.
  const existing = ROUTER_PRESETS.find(p => p.id === channel.id);
  if (existing) { existing.icon = channel.icon; continue; }
  ROUTER_PRESETS.push({ id: channel.id, name: channel.name, subscription: channel.id as SubscriptionId,
    endpoints: Object.fromEntries([channel.protocol, ...Object.keys(channel.modelsByProtocol)].map(protocol => [protocol, channel.baseUrl])), models: channel.models, icon: channel.icon });
}
export function subscriptionMethods(id: string): SubscriptionMethod[] {
  return SUBSCRIPTION_IDS.some(value => value === id) ? ['browser'] : [];
}
export function routerPreset(id: string): RouterPreset | undefined { return ROUTER_PRESETS.find(p => p.id === id); }
export function makeRouterPreset(id: string, protocol?: Protocol, method: SubscriptionMethod = 'browser'): RouterProvider {
  const preset = routerPreset(id);
  if (!preset) throw new Error('UNSUPPORTED_PRESET_PROTOCOL');
  protocol ??= preferredClientProtocol(Object.keys(preset.endpoints) as Protocol[]);
  if (!preset.endpoints[protocol]) throw new Error('UNSUPPORTED_PRESET_PROTOCOL');
  return { id: `${id}${protocol === 'chat' ? '' : '-' + protocol}`, name: preset.name, enabled: true, preset: id,
    protocol, baseUrl: preset.endpoints[protocol]!, models: [...(CHANNEL_CATALOG.find(p => p.id === id)?.modelsByProtocol[protocol] ?? preset.models)],
    auth: preset.subscription ? { kind: 'subscription', provider: preset.subscription, method,
      ...(['env', 'pat-env'].includes(method) ? { variable: preset.variable! } : {}) } : { kind: 'env', variable: preset.variable! } };
}

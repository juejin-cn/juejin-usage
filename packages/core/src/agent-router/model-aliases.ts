import type { AgentRouterConfig, RouterProvider } from './config.js';
import { ROUTER_PRESETS } from './presets.js';

const UUID_SUFFIX = /-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const CUSTOM_ID = /^custom-(.+)-[a-f\d]{8}$/;
function aliasBase(provider: RouterProvider): string | undefined {
  if (UUID_SUFFIX.test(provider.id)) return provider.id.replace(UUID_SUFFIX, '');
  if (provider.preset === undefined && provider.auth.kind === 'env') return CUSTOM_ID.exec(provider.id)?.[1];
}
/** Allocate once, then persist with the provider. Removing or reordering another
 * account must never move an existing alias onto a different credential. */
export function assignProviderAliases(providers: RouterProvider[]): void {
  const used = new Set(['auto', ...providers.map(p => p.id), ...providers.flatMap(p => p.alias ? [p.alias] : [])]);
  // Preset ids double as fixed provider ids, so a custom name must not claim them.
  const presets = ROUTER_PRESETS.flatMap(p => [p.id, ...['responses', 'messages', 'gemini'].map(protocol => `${p.id}-${protocol}`)]);
  for (const provider of [...providers].sort((a, b) => a.id.localeCompare(b.id))) {
    const base = provider.alias ? undefined : aliasBase(provider);
    if (!base) continue;
    const taken = UUID_SUFFIX.test(provider.id) ? used : new Set([...used, ...presets]);
    let alias = base; let number = 2;
    while (taken.has(alias)) alias = `${base}-${number++}`;
    provider.alias = alias; used.add(alias);
  }
}
export function publicModelId(provider: RouterProvider, model: string): string {
  return `${provider.alias ?? provider.id}/${model}`;
}
/** Long IDs remain accepted but are no longer repeated in discovery menus. */
export function resolveModelId(config: AgentRouterConfig, requested: string): string | undefined {
  for (const provider of config.providers) for (const model of provider.models) {
    if (provider.excludedModels?.includes(model)) continue;
    const legacy = `${provider.id}/${model}`;
    if (requested === legacy || requested === publicModelId(provider, model)) return legacy;
  }
}

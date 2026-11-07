import type { AgentRouterConfig, RouterProvider } from './config.js';

const UUID_SUFFIX = /-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
/** Allocate once, then persist with the provider. Removing or reordering another
 * account must never move an existing alias onto a different credential. */
export function assignProviderAliases(providers: RouterProvider[]): void {
  const used = new Set(['auto', ...providers.map(p => p.id), ...providers.flatMap(p => p.alias ? [p.alias] : [])]);
  for (const provider of [...providers].sort((a, b) => a.id.localeCompare(b.id))) {
    if (provider.alias || !UUID_SUFFIX.test(provider.id)) continue;
    const base = provider.id.replace(UUID_SUFFIX, '');
    let alias = base; let number = 2;
    while (used.has(alias)) alias = `${base}-${number++}`;
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

import { exposedModels, type AgentRouterConfig, type RouterGroup } from './config.js';

/** Derived groups never modify persisted manual groups or merge different protocols. */
export function automaticGroups(config: AgentRouterConfig): RouterGroup[] {
  if (!config.autoGroups) return [];
  const buckets = new Map<string, string[]>();
  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    for (const model of exposedModels(provider)) {
      let encoded: string;
      try { encoded = encodeURIComponent(model); } catch { continue; } // Invalid Unicode cannot form a catalog identifier.
      const id = `generated/${provider.protocol}/${encoded}`;
      const members = buckets.get(id) ?? [];
      if (members.length < 16) members.push(`${provider.id}/${model}`);
      buckets.set(id, members);
    }
  }
  return [...buckets].filter(([, members]) => members.length >= 2).slice(0, 128)
    .map(([id, members]) => ({ id, members, strategy: 'ordered' }));
}
export function effectiveGroups(config: AgentRouterConfig): RouterGroup[] {
  return [...config.groups, ...automaticGroups(config)];
}

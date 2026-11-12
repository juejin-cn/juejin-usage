import type { RouterProvider } from '@juejin-opensource/jusage-core/agent-router';
import { CHANNEL_CATALOG } from '@juejin-opensource/jusage-core/agent-router/presets';
import { compareByPriority } from './compare-priority.ts';

/** Mainstream subscription presets first; unlisted ids stay after these. */
export const GATEWAY_PROVIDER_PRIORITY = [
  'claude', 'codex', 'workbuddy', 'grok', 'trae-cn', 'minimax-code',
  'github-copilot', 'cursor', 'kimi-work', 'minimax-code-global', 'qoder', 'qoder-cn',
  'trae-global', 'workbuddy-ai', 'zcode', 'opencode-go', 'opencode-zen-free',
  'qwenwork', 'qwenwork-enterprise', 'kiro', 'volcengine', 'antigravity',
] as const;

export function compareGatewayProviderPriority(a: string, b: string): number {
  return compareByPriority(a, b, GATEWAY_PROVIDER_PRIORITY);
}

export function isVisibleGatewayProvider(provider: RouterProvider): boolean {
  return provider.auth.kind !== 'subscription' || CHANNEL_CATALOG.some(channel => channel.id === (provider.auth as { provider: string }).provider);
}

export function channelKey(provider: RouterProvider): string {
  if (provider.auth.kind === 'subscription') return 'subscription:' + provider.auth.provider;
  return provider.preset && provider.preset !== 'custom' ? 'preset:' + provider.preset : 'account:' + provider.id;
}

/** Group before filtering so partially disabled channels appear only once. */
export function groupChannels(providers: RouterProvider[]): RouterProvider[][] {
  const groups = new Map<string, RouterProvider[]>();
  for (const provider of providers) {
    const key = channelKey(provider);
    const accounts = groups.get(key) ?? [];
    accounts.push(provider); groups.set(key, accounts);
  }
  return [...groups.values()];
}

export function setChannelEnabled(providers: RouterProvider[], provider: RouterProvider, enabled: boolean): RouterProvider[] {
  return providers.map(account => channelKey(account) === channelKey(provider) ? { ...account, enabled } : account);
}

export function applyChannelModelDrafts(providers: RouterProvider[], provider: RouterProvider, drafts: Record<string, string[]>): RouterProvider[] {
  return providers.map(account => channelKey(account) === channelKey(provider) && Object.hasOwn(drafts, account.id)
    ? { ...account, models: [...drafts[account.id]] } : account);
}

/** Apply account edits only within the current subscription, leaving routing and credentials intact. */
export function applyChannelAccountDrafts(providers: RouterProvider[], provider: RouterProvider, drafts: Record<string, { name?: string; enabled?: boolean }>): RouterProvider[] {
  return providers.map(account => {
    const draft = drafts[account.id];
    if (channelKey(account) !== channelKey(provider) || !draft) return account;
    return { ...account, name: draft.name?.trim() || account.name, enabled: draft.enabled ?? account.enabled };
  });
}

/** Change exposure per account without removing models from its available catalog. */
export function applyAccountExposureDrafts(providers: RouterProvider[], drafts: Record<string, Record<string, boolean>>): RouterProvider[] {
  return providers.map(provider => {
    const draft = drafts[provider.id];
    if (!draft) return provider;
    const excludedModels = provider.models.filter(model =>
      Object.hasOwn(draft, model) ? !draft[model] : provider.excludedModels?.includes(model));
    return { ...provider, excludedModels };
  });
}

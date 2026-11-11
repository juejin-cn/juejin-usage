/** Dashboard / tray subscription channel ids and display preferences. */

export const SUBSCRIPTION_CHANNEL_VISIBILITY_KEY =
  'tud.subscriptionChannelVisibility';

export const SUBSCRIPTION_CHANNEL_VISIBILITY_EVENT =
  'tud:subscription-channel-visibility';

/** Channels served by the local subscription API. */
export const SUBSCRIPTION_CHANNELS = [
  { id: 'trae-cn', label: 'Trae 国内版' },
  { id: 'trae-global', label: 'Trae 国际版' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'grok', label: 'Grok' },
  { id: 'grokbot', label: 'Grok Bot' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'zcode', label: 'ZCode' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'qoder', label: 'Qoder' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'deepseek', label: 'DeepSeek' },
] as const;

export type SubscriptionChannelId =
  (typeof SUBSCRIPTION_CHANNELS)[number]['id'];

/** All allowance cards use the same local channel settings. */
export const SUBSCRIPTION_CARD_CHANNELS = SUBSCRIPTION_CHANNELS;
export type SubscriptionCardChannelId = SubscriptionChannelId;

/** Missing keys default to visible (`true`). */
export type SubscriptionChannelVisibility = Partial<
  Record<SubscriptionCardChannelId, boolean>
>;

export function isSubscriptionChannelId(
  value: unknown,
): value is SubscriptionChannelId {
  return (
    typeof value === 'string' &&
    SUBSCRIPTION_CHANNELS.some((channel) => channel.id === value)
  );
}

export function isSubscriptionChannelVisibility(
  value: unknown,
): value is SubscriptionChannelVisibility {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).every(
    ([key, enabled]) =>
      SUBSCRIPTION_CARD_CHANNELS.some(channel => channel.id === key) && typeof enabled === 'boolean',
  );
}

/** Channels default to shown; only explicit `false` hides them. */
export function isSubscriptionChannelEnabled(
  visibility: SubscriptionChannelVisibility,
  id: SubscriptionCardChannelId,
): boolean {
  return visibility[id] !== false;
}

export function readSubscriptionChannelVisibility(): SubscriptionChannelVisibility {
  try {
    const raw = localStorage.getItem(SUBSCRIPTION_CHANNEL_VISIBILITY_KEY);
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'trae' in parsed) {
      const { trae, ...rest } = parsed as Record<string, unknown>;
      const migrated = { ...rest, ...(!('trae-global' in rest) && typeof trae === 'boolean' ? { 'trae-global': trae } : {}) };
      return isSubscriptionChannelVisibility(migrated) ? migrated : {};
    }
    return isSubscriptionChannelVisibility(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSubscriptionChannelVisibility(
  visibility: SubscriptionChannelVisibility,
): void {
  try {
    localStorage.setItem(
      SUBSCRIPTION_CHANNEL_VISIBILITY_KEY,
      JSON.stringify(visibility),
    );
  } catch {
    // ignore private mode / quota
  }
  window.dispatchEvent(
    new CustomEvent(SUBSCRIPTION_CHANNEL_VISIBILITY_EVENT),
  );
}

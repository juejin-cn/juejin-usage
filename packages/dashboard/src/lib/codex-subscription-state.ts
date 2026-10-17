import type { CodexSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/codex-subscription';

export interface CodexSubscriptionState {
  snapshot: CodexSubscriptionSnapshot | null;
  lastUpdatedAt: number | null;
}

export const INITIAL_CODEX_SUBSCRIPTION_STATE: CodexSubscriptionState = {
  snapshot: null,
  lastUpdatedAt: null,
};

/** Transient failures recover on focus; main-process caching limits requests. */
export function shouldRefreshCodexOnFocus(snapshot: CodexSubscriptionSnapshot): boolean {
  return !snapshot.hasAccount || snapshot.status === 'ready' || snapshot.status === 'unavailable';
}

/** The main process owns account-aware caching; the renderer never merges allowances. */
export function updateCodexSubscriptionState(
  _previous: CodexSubscriptionState,
  snapshot: CodexSubscriptionSnapshot,
  _now: number,
): CodexSubscriptionState {
  if (!snapshot.hasAccount) return INITIAL_CODEX_SUBSCRIPTION_STATE;
  return {
    snapshot,
    lastUpdatedAt: snapshot.fetchedAt === null ? null : snapshot.fetchedAt * 1000,
  };
}

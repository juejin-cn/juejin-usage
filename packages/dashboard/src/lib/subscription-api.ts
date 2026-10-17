import type { SubscriptionReadOptions, SubscriptionSnapshotByChannel } from '@juejin-opensource/jusage-core/subscription';
import { isCliBackend } from './api';
import { createSubscriptionClient } from './subscription-request';

const read = createSubscriptionClient(isCliBackend());

export const subscriptionApi = {
  getCodexSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['codex']> => read('codex', options),
  getClaudeSubscription: (options?: SubscriptionReadOptions & { allowCredentialAccess?: boolean }): Promise<SubscriptionSnapshotByChannel['claude']> => read('claude', options),
  getCursorSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['cursor']> => read('cursor', options),
  getCopilotSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['copilot']> => read('copilot', options),
  getGrokSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['grok']> => read('grok', options),
  getKimiSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['kimi']> => read('kimi', options),
  getZcodeSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['zcode']> => read('zcode', options),
  getAntigravitySubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['antigravity']> => read('antigravity', options),
  getQoderSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['qoder']> => read('qoder', options),
  getMiniMaxSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['minimax']> => read('minimax', options),
  getOpenCodeSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['opencode']> => read('opencode', options),
  getDeepSeekSubscription: (options?: SubscriptionReadOptions): Promise<SubscriptionSnapshotByChannel['deepseek']> => read('deepseek', options),
};

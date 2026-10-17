import type { SubscriptionChannelId, SubscriptionReadOptions, SubscriptionSnapshotByChannel } from './index.js';
import { readCodexSubscription } from './readers/codex-subscription.js';
import { readClaudeSubscription } from './readers/claude-subscription.js';
import { readCursorSubscription } from './readers/cursor-subscription.js';
import { readCopilotSubscription } from './readers/copilot-subscription.js';
import { readGrokSubscription } from './readers/grok-subscription.js';
import { readKimiSubscriptions } from './readers/kimi-subscription.js';
import { readZcodeSubscription } from './readers/zcode-subscription.js';
import { readAntigravitySubscription } from './readers/antigravity-subscription.js';
import { readQoderSubscription } from './readers/qoder-subscription.js';
import { readMiniMaxSubscription } from './readers/minimax-subscription.js';
import { readOpenCodeSubscription } from './readers/opencode-subscription.js';
import { readDeepSeekSubscription } from './readers/deepseek-subscription.js';

const readers: { [K in SubscriptionChannelId]: (options?: SubscriptionReadOptions) => Promise<SubscriptionSnapshotByChannel[K]> } = {
  codex: readCodexSubscription,
  claude: readClaudeSubscription,
  cursor: readCursorSubscription,
  copilot: readCopilotSubscription,
  grok: readGrokSubscription,
  kimi: readKimiSubscriptions,
  zcode: readZcodeSubscription,
  antigravity: readAntigravitySubscription,
  qoder: readQoderSubscription,
  minimax: readMiniMaxSubscription,
  opencode: readOpenCodeSubscription,
  deepseek: readDeepSeekSubscription,
};

export function readSubscription<K extends SubscriptionChannelId>(
  channel: K,
  options?: SubscriptionReadOptions,
): Promise<SubscriptionSnapshotByChannel[K]> {
  return readers[channel](options);
}

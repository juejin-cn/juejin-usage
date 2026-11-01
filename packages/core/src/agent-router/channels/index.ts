import type { SubscriptionId } from '../presets.js';
import type { SubscriptionChannel } from '../subscription-types.js';
import { claudeChannel } from '../native/claude.js';
import { codexChannel } from '../native/codex.js';
import { copilotChannel } from './copilot.js';
import { cursorChannel } from './cursor.js';
import { grokChannel } from './grok.js';
import { kimiWorkChannel } from './kimi-work.js';
import { kiroChannel } from './kiro.js';
import { minimaxChannel } from './minimax.js';
import { qoderChannel } from './qoder.js';
import { traeChannel } from './trae.js';
import { workbuddyChannel } from './workbuddy.js';
import { zcodeChannel } from './zcode.js';
import { zenFreeChannel } from './zen-free.js';
export function createSubscriptionChannel(id: SubscriptionId): SubscriptionChannel {
  switch (id) {
    case 'claude': return claudeChannel();
    case 'codex': return codexChannel();
    case 'github-copilot': return copilotChannel();
    case 'cursor': return cursorChannel();
    case 'grok': return grokChannel();
    case 'kimi-work': return kimiWorkChannel();
    case 'kiro': return kiroChannel();
    case 'minimax-code': return minimaxChannel(false);
    case 'minimax-code-global': return minimaxChannel(true);
    case 'qoder': case 'qoder-cn': case 'qwenwork': case 'qwenwork-enterprise': return qoderChannel(id);
    case 'trae-cn': return traeChannel(false);
    case 'trae-global': return traeChannel(true);
    case 'workbuddy': return workbuddyChannel(false);
    case 'workbuddy-ai': return workbuddyChannel(true);
    case 'zcode': return zcodeChannel();
    case 'opencode-zen-free': return zenFreeChannel();
  }
}

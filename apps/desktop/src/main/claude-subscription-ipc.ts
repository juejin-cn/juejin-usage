import { ipcMain } from 'electron';
import { readClaudeSubscription } from './claude-subscription';

export const CLAUDE_SUBSCRIPTION_GET_CHANNEL = 'claude-subscription:get';

export function registerClaudeSubscriptionIpc(): () => void {
  ipcMain.removeHandler(CLAUDE_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(CLAUDE_SUBSCRIPTION_GET_CHANNEL, (_event, options: unknown) => {
    const input = options && typeof options === 'object'
      ? options as Record<string, unknown>
      : {};
    return readClaudeSubscription({
      allowCredentialAccess: input.allowCredentialAccess === true,
      forceRefresh: input.forceRefresh === true,
    });
  });
  return () => ipcMain.removeHandler(CLAUDE_SUBSCRIPTION_GET_CHANNEL);
}

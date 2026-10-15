import { ipcMain, net } from 'electron';
import { createCodexSubscriptionReader } from './codex-subscription';

export const CODEX_SUBSCRIPTION_GET_CHANNEL = 'codex-subscription:get';

// Chromium's network stack honors the system proxy; share one cache across all callers.
const readCodexSubscription = createCodexSubscriptionReader({ fetch: (url, options) => net.fetch(url, options) });

export function registerCodexSubscriptionIpc(): () => void {
  ipcMain.removeHandler(CODEX_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(CODEX_SUBSCRIPTION_GET_CHANNEL, (_event, options: unknown) => {
    const input = options && typeof options === 'object' ? options as Record<string, unknown> : {};
    return readCodexSubscription({ forceRefresh: input.forceRefresh === true });
  });
  return () => ipcMain.removeHandler(CODEX_SUBSCRIPTION_GET_CHANNEL);
}

import { ipcMain } from 'electron';
import { readCodexSubscription } from './codex-subscription';

export const CODEX_SUBSCRIPTION_GET_CHANNEL = 'codex-subscription:get';

export function registerCodexSubscriptionIpc(): () => void {
  ipcMain.removeHandler(CODEX_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(CODEX_SUBSCRIPTION_GET_CHANNEL, () => readCodexSubscription());
  return () => ipcMain.removeHandler(CODEX_SUBSCRIPTION_GET_CHANNEL);
}

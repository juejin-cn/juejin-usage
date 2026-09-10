import { ipcMain } from 'electron';
import { readAntigravitySubscription } from './antigravity-subscription';

export const ANTIGRAVITY_SUBSCRIPTION_GET_CHANNEL = 'antigravity-subscription:get';

export function registerAntigravitySubscriptionIpc(): () => void {
  ipcMain.removeHandler(ANTIGRAVITY_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(ANTIGRAVITY_SUBSCRIPTION_GET_CHANNEL, () => readAntigravitySubscription());
  return () => ipcMain.removeHandler(ANTIGRAVITY_SUBSCRIPTION_GET_CHANNEL);
}

import { ipcMain } from 'electron';
import { readKimiSubscription } from './kimi-subscription';

export const KIMI_SUBSCRIPTION_GET_CHANNEL = 'kimi-subscription:get';

export function registerKimiSubscriptionIpc(): () => void {
  ipcMain.removeHandler(KIMI_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(KIMI_SUBSCRIPTION_GET_CHANNEL, () => readKimiSubscription());
  return () => ipcMain.removeHandler(KIMI_SUBSCRIPTION_GET_CHANNEL);
}

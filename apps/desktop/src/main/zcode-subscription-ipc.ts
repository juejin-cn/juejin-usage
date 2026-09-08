import { ipcMain } from 'electron';
import { readZcodeSubscription } from './zcode-subscription';

export const ZCODE_SUBSCRIPTION_GET_CHANNEL = 'zcode-subscription:get';

export function registerZcodeSubscriptionIpc(): () => void {
  ipcMain.removeHandler(ZCODE_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(ZCODE_SUBSCRIPTION_GET_CHANNEL, () => readZcodeSubscription());
  return () => ipcMain.removeHandler(ZCODE_SUBSCRIPTION_GET_CHANNEL);
}

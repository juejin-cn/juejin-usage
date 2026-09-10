import { ipcMain } from 'electron';
import {
  readGrokSubscription,
  terminateGrokSubscriptionProcesses,
} from './grok-subscription';

export const GROK_SUBSCRIPTION_GET_CHANNEL = 'grok-subscription:get';

export function registerGrokSubscriptionIpc(): () => void {
  ipcMain.removeHandler(GROK_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(GROK_SUBSCRIPTION_GET_CHANNEL, () => readGrokSubscription());
  return () => {
    ipcMain.removeHandler(GROK_SUBSCRIPTION_GET_CHANNEL);
    terminateGrokSubscriptionProcesses();
  };
}

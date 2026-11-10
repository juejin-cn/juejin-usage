import { readGrokBotSubscription } from '@juejin-opensource/jusage-core/subscription/readers/grokbot-subscription';
import { ipcMain } from 'electron';
import {
  readGrokSubscription,
  terminateGrokSubscriptionProcesses,
} from './grok-subscription';

export const GROKBOT_SUBSCRIPTION_GET_CHANNEL = 'grokbot-subscription:get';

export const GROK_SUBSCRIPTION_GET_CHANNEL = 'grok-subscription:get';

export function registerGrokSubscriptionIpc(): () => void {
  ipcMain.removeHandler(GROKBOT_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(GROKBOT_SUBSCRIPTION_GET_CHANNEL, (_event, options?: { forceRefresh?: boolean }) => readGrokBotSubscription({ forceRefresh: options?.forceRefresh === true }));
  ipcMain.removeHandler(GROK_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(GROK_SUBSCRIPTION_GET_CHANNEL, (_event, options?: { forceRefresh?: boolean }) => readGrokSubscription({ forceRefresh: options?.forceRefresh === true }));
  return () => {
    ipcMain.removeHandler(GROKBOT_SUBSCRIPTION_GET_CHANNEL);
    ipcMain.removeHandler(GROK_SUBSCRIPTION_GET_CHANNEL);
    terminateGrokSubscriptionProcesses();
  };
}

import { ipcMain } from 'electron';
import { readCursorSubscription } from './cursor-subscription';

export const CURSOR_SUBSCRIPTION_GET_CHANNEL = 'cursor-subscription:get';

export function registerCursorSubscriptionIpc(): () => void {
  ipcMain.removeHandler(CURSOR_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(CURSOR_SUBSCRIPTION_GET_CHANNEL, () => readCursorSubscription());
  return () => ipcMain.removeHandler(CURSOR_SUBSCRIPTION_GET_CHANNEL);
}

import { ipcMain } from 'electron';
import { configureCursorKeychainPasswordStore, readCursorSubscription } from './cursor-subscription';
import { createCursorKeychainPasswordStore } from './cursor-keychain-store';

export const CURSOR_SUBSCRIPTION_GET_CHANNEL = 'cursor-subscription:get';

export function registerCursorSubscriptionIpc(): () => void {
  if (process.platform === 'darwin') configureCursorKeychainPasswordStore(createCursorKeychainPasswordStore());
  ipcMain.removeHandler(CURSOR_SUBSCRIPTION_GET_CHANNEL);
  ipcMain.handle(CURSOR_SUBSCRIPTION_GET_CHANNEL, (_event, options?: { forceRefresh?: boolean }) => readCursorSubscription({ forceRefresh: options?.forceRefresh === true }));
  return () => {
    ipcMain.removeHandler(CURSOR_SUBSCRIPTION_GET_CHANNEL);
    configureCursorKeychainPasswordStore(null);
  };
}

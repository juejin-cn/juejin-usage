import { ipcMain } from 'electron';
import { readTraeGlobalSubscription, readTraeCnSubscription } from '@juejin-opensource/jusage-core/subscription/readers/trae-subscription';
import type { TraeRegion } from '../shared/trae-subscription';

export const TRAE_GLOBAL_SUBSCRIPTION_GET_CHANNEL = 'trae-global-subscription:get';
export const TRAE_CN_SUBSCRIPTION_GET_CHANNEL = 'trae-cn-subscription:get';

function registerTraeRegionIpc(channel: string, region: TraeRegion): () => void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (_event, options?: { forceRefresh?: boolean }) =>
    (region === 'global' ? readTraeGlobalSubscription(options) : readTraeCnSubscription(options)));
  return () => ipcMain.removeHandler(channel);
}

export function registerTraeSubscriptionIpc(): () => void {
  const disposeGlobal = registerTraeRegionIpc(TRAE_GLOBAL_SUBSCRIPTION_GET_CHANNEL, 'global');
  const disposeMainland = registerTraeRegionIpc(TRAE_CN_SUBSCRIPTION_GET_CHANNEL, 'mainland');
  return () => {
    disposeGlobal();
    disposeMainland();
  };
}

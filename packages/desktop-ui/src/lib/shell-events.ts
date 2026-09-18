/** Lightweight shell ↔ page bridging without lifting data hooks. */

export const DATA_SYNCED_EVENT = 'tud:data-synced';
export const OPEN_SETTINGS_EVENT = 'tud:open-settings';
export const OPEN_ABOUT_EVENT = 'tud:open-about';
export const OPEN_SHARE_EVENT = 'tud:open-share';
/** Fired after Juejin link/unlink so chrome can refresh「关联掘金」. */
export const JUEJIN_LINK_CHANGED_EVENT = 'tud:juejin-link-changed';

export type SettingsTabId = 'sync' | 'pet' | 'app' | 'about';

export type OpenSettingsDetail = {
  tab?: SettingsTabId;
  /** Re-fetch CLI config (used after deep-link association). */
  reloadConfig?: boolean;
  /** Deep-link wrote user_id successfully — show login toast. */
  loginSuccess?: boolean;
  /** Deep-link apply failed — show danger toast (does not clear token). */
  loginError?: string;
};

export function dispatchDataSynced() {
  window.dispatchEvent(new CustomEvent(DATA_SYNCED_EVENT));
}

export function dispatchOpenSettings(detail?: OpenSettingsDetail) {
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, { detail: detail ?? {} }),
  );
}

export function dispatchOpenAbout() {
  window.dispatchEvent(new CustomEvent(OPEN_ABOUT_EVENT));
}

export function dispatchOpenShare() {
  window.dispatchEvent(new CustomEvent(OPEN_SHARE_EVENT));
}

export function dispatchJuejinLinkChanged() {
  window.dispatchEvent(new CustomEvent(JUEJIN_LINK_CHANGED_EVENT));
}

export function shareCurrentPage() {
  dispatchOpenShare();
  return Promise.resolve();
}

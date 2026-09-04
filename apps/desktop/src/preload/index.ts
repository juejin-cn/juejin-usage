/**
 * Preload bridge for jusage-desktop.
 *
 * Exposes a small, audited surface to the renderer via `contextBridge`:
 *  - window controls (minimize / maximize / close)
 *  - tud.api.request → in-process local-api (same contract as CLI :8452)
 *  - tud.onDataSynced → Core poll / sync watcher refresh
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  AUTO_UPDATE_ACK_COMPLETED_CHANNEL,
  AUTO_UPDATE_CHECK_CHANNEL,
  AUTO_UPDATE_GET_STATE_CHANNEL,
  AUTO_UPDATE_INSTALL_CHANNEL,
  AUTO_UPDATE_STATE_CHANGED_CHANNEL,
  type AutoUpdateState,
} from '../shared/auto-update';
import {
  DASHBOARD_RANGE_CHANGED_CHANNEL,
  DASHBOARD_RANGE_GET_CHANNEL,
  DASHBOARD_RANGE_SET_CHANNEL,
  isDashboardRange,
  type DashboardRange,
} from '../shared/dashboard-range';
import { isThemeMode, type Theme, type ThemeMode } from '../shared/theme';

const API_REQUEST_CHANNEL = 'tud:api-request';
const DATA_SYNCED_CHANNEL = 'tud:data-synced';
const OPEN_SETTINGS_CHANNEL = 'app:open-settings';
const JUEJIN_LINK_RESULT_CHANNEL = 'app:juejin-link-result';
const RUNTIME_NOTICE_CHANNEL = 'app:runtime-notice';
const OPEN_EXTERNAL_CHANNEL = 'shell:open-external';
const TRAY_POPOVER_RESIZE_CHANNEL = 'tray-popover:resize';
const THEME_GET_CHANNEL = 'theme:get';
const THEME_SET_CHANNEL = 'theme:set';
const THEME_CHANGED_CHANNEL = 'theme:changed';
const AUTOSTART_GET_CHANNEL = 'autostart:get';
const AUTOSTART_SET_CHANNEL = 'autostart:set';
const AUTOSTART_GET_HIDDEN_CHANNEL = 'autostart:get-hidden';
const AUTOSTART_SET_HIDDEN_CHANNEL = 'autostart:set-hidden';
const DESKTOP_PET_GET_CHANNEL = 'desktop-pet:get';
const DESKTOP_PET_SET_ENABLED_CHANNEL = 'desktop-pet:set-enabled';
const DESKTOP_PET_SET_MOUSE_IGNORE_CHANNEL = 'desktop-pet:set-ignore-mouse-events';
const DESKTOP_PET_ANIMATION_CHANNEL = 'desktop-pet:animation';
const DESKTOP_PET_CATALOG_CHANNEL = 'desktop-pet:catalog';
const DESKTOP_PET_REFRESH_CATALOG_CHANNEL = 'desktop-pet:refresh-catalog';
const DESKTOP_PET_OPEN_DIRECTORY_CHANNEL = 'desktop-pet:open-directory';
const DESKTOP_PET_SPRITESHEET_URL_CHANNEL = 'desktop-pet:spritesheet-url';
const SHARE_CARD_COPY_IMAGE_CHANNEL = 'share-card:copy-image';

type SettingsTabId = 'sync' | 'pet' | 'app';

type PetAnimation = 'idle' | 'running-left' | 'running-right';

const tudApi = {
  version: () => '0.1.0',
  platform: process.platform,

  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  showMainWindow: () => ipcRenderer.send('window:show'),
  quit: () => ipcRenderer.send('app:quit'),

  getAutoUpdateState: (): Promise<AutoUpdateState> =>
    ipcRenderer.invoke(AUTO_UPDATE_GET_STATE_CHANNEL),

  checkForUpdates: (): Promise<AutoUpdateState> =>
    ipcRenderer.invoke(AUTO_UPDATE_CHECK_CHANNEL),

  installDownloadedUpdate: (): Promise<AutoUpdateState> =>
    ipcRenderer.invoke(AUTO_UPDATE_INSTALL_CHANNEL),

  acknowledgeUpdateCompleted: (): Promise<void> =>
    ipcRenderer.invoke(AUTO_UPDATE_ACK_COMPLETED_CHANNEL),

  onAutoUpdateStateChanged: (
    callback: (state: AutoUpdateState) => void,
  ) => {
    const listener = (_event: unknown, state: AutoUpdateState) => callback(state);
    ipcRenderer.on(AUTO_UPDATE_STATE_CHANGED_CHANNEL, listener);
    return () =>
      ipcRenderer.removeListener(AUTO_UPDATE_STATE_CHANGED_CHANNEL, listener);
  },

  copyImageToClipboard: (dataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke(SHARE_CARD_COPY_IMAGE_CHANNEL, dataUrl),

  /** Open http(s) in the OS default browser (掘金登录). */
  openExternal: (
    url: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),

  /**
   * Ask the main process to re-height the tray popover. Main owns the bounds
   * because it also has to re-anchor the window to the tray icon; the renderer
   * only knows how tall its content wants to be.
   */
  resizeTrayPopover: (height: number) =>
    ipcRenderer.send(TRAY_POPOVER_RESIZE_CHANNEL, height),

  getDashboardRange: (): Promise<DashboardRange> =>
    ipcRenderer.invoke(DASHBOARD_RANGE_GET_CHANNEL),

  setDashboardRange: (range: DashboardRange): Promise<DashboardRange> =>
    ipcRenderer.invoke(DASHBOARD_RANGE_SET_CHANNEL, range),

  onDashboardRange: (callback: (range: DashboardRange) => void) => {
    const listener = (_event: unknown, range: unknown) => {
      if (isDashboardRange(range)) callback(range);
    };
    ipcRenderer.on(DASHBOARD_RANGE_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DASHBOARD_RANGE_CHANGED_CHANNEL, listener);
  },

  getTheme: (): Promise<{ mode: ThemeMode; resolved: Theme }> =>
    ipcRenderer.invoke(THEME_GET_CHANNEL),

  setThemeMode: (mode: ThemeMode) =>
    ipcRenderer.send(THEME_SET_CHANNEL, mode),

  onThemeChanged: (
    callback: (state: { mode: ThemeMode; resolved: Theme }) => void,
  ) => {
    const listener = (
      _event: unknown,
      state: { mode: ThemeMode; resolved: Theme },
    ) => {
      if (isThemeMode(state?.mode) && (state.resolved === 'light' || state.resolved === 'dark')) {
        callback(state);
      }
    };
    ipcRenderer.on(THEME_CHANGED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(THEME_CHANGED_CHANNEL, listener);
  },

  getOpenAtLogin: (): Promise<boolean> =>
    ipcRenderer.invoke(AUTOSTART_GET_CHANNEL),

  setOpenAtLogin: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(AUTOSTART_SET_CHANNEL, enabled),

  getLaunchHidden: (): Promise<boolean> =>
    ipcRenderer.invoke(AUTOSTART_GET_HIDDEN_CHANNEL),

  setLaunchHidden: (hidden: boolean): Promise<boolean> =>
    ipcRenderer.invoke(AUTOSTART_SET_HIDDEN_CHANNEL, hidden),

  getDesktopPet: (): Promise<{
    enabled: boolean;
    selectedPetId: string;
    position?: { x: number; y: number };
    scale: number;
    frameIntervalMs: number;
    autoMoveEnabled: boolean;
    autoMoveIntervalMinutes: number;
  }> => ipcRenderer.invoke(DESKTOP_PET_GET_CHANNEL),

  setDesktopPetEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(DESKTOP_PET_SET_ENABLED_CHANNEL, enabled),

  getDesktopPetCatalog: () => ipcRenderer.invoke(DESKTOP_PET_CATALOG_CHANNEL),

  refreshDesktopPetCatalog: () => ipcRenderer.invoke(DESKTOP_PET_REFRESH_CATALOG_CHANNEL),

  openDesktopPetDirectory: (): Promise<string> => ipcRenderer.invoke(DESKTOP_PET_OPEN_DIRECTORY_CHANNEL),

  getDesktopPetSpritesheetUrl: (id: string): Promise<string> =>
    ipcRenderer.invoke(DESKTOP_PET_SPRITESHEET_URL_CHANNEL, id),

  setSelectedDesktopPet: (selectedPetId: string): Promise<{
    enabled: boolean;
    selectedPetId: string;
    position?: { x: number; y: number };
    scale: number;
    frameIntervalMs: number;
    autoMoveEnabled: boolean;
    autoMoveIntervalMinutes: number;
  }> => ipcRenderer.invoke('desktop-pet:set-selected', selectedPetId),

  setDesktopPetPreferences: (changes: {
    scale?: number;
    frameIntervalMs?: number;
    autoMoveEnabled?: boolean;
    autoMoveIntervalMinutes?: number;
  }): Promise<{
    enabled: boolean;
    selectedPetId: string;
    position?: { x: number; y: number };
    scale: number;
    frameIntervalMs: number;
    autoMoveEnabled: boolean;
    autoMoveIntervalMinutes: number;
  }> => ipcRenderer.invoke('desktop-pet:set-preferences', changes),

  setDesktopPetMouseIgnored: (ignored: boolean) =>
    ipcRenderer.send(DESKTOP_PET_SET_MOUSE_IGNORE_CHANNEL, ignored),

  /**
   * Hands the drag to main, which then follows the OS cursor itself. The
   * renderer deliberately sends no per-move coordinates: an IPC message per
   * pointermove is what makes the pet lag behind the cursor.
   */
  beginDesktopPetDrag: () => ipcRenderer.send('desktop-pet:begin-drag'),
  endDesktopPetDrag: () => ipcRenderer.send('desktop-pet:end-drag'),

  onDesktopPetAnimation: (callback: (animation: PetAnimation) => void) => {
    const listener = (_event: unknown, animation: PetAnimation) => {
      if (animation === 'idle' || animation === 'running-left' || animation === 'running-right') {
        callback(animation);
      }
    };
    ipcRenderer.on(DESKTOP_PET_ANIMATION_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DESKTOP_PET_ANIMATION_CHANNEL, listener);
  },

  onDesktopPetPreferences: (callback: (preferences: {
    enabled: boolean;
    selectedPetId: string;
    position?: { x: number; y: number };
    scale: number;
    frameIntervalMs: number;
    autoMoveEnabled: boolean;
    autoMoveIntervalMinutes: number;
  }) => void) => {
    const listener = (_event: unknown, preferences: unknown) => {
      if (!preferences || typeof preferences !== 'object') return;
      const value = preferences as {
        enabled?: unknown;
        selectedPetId?: unknown;
        position?: { x?: unknown; y?: unknown };
        scale?: unknown;
        frameIntervalMs?: unknown;
        autoMoveEnabled?: unknown;
        autoMoveIntervalMinutes?: unknown;
      };
      if (typeof value.enabled !== 'boolean' || typeof value.selectedPetId !== 'string' || typeof value.scale !== 'number' || typeof value.frameIntervalMs !== 'number' || typeof value.autoMoveEnabled !== 'boolean' || typeof value.autoMoveIntervalMinutes !== 'number') return;
      callback({
        enabled: value.enabled,
        selectedPetId: value.selectedPetId,
        scale: value.scale,
        frameIntervalMs: value.frameIntervalMs,
        autoMoveEnabled: value.autoMoveEnabled,
        autoMoveIntervalMinutes: value.autoMoveIntervalMinutes,
        ...(typeof value.position?.x === 'number' && typeof value.position.y === 'number'
          ? { position: { x: value.position.x, y: value.position.y } }
          : {}),
      });
    };
    ipcRenderer.on('desktop-pet:preferences', listener);
    return () => ipcRenderer.removeListener('desktop-pet:preferences', listener);
  },

  /**
   * Returns an unsubscribe function. Always prefer this over leaking
   * listeners across re-renders.
   */
  onMaximized: (callback: (isMaximized: boolean) => void) => {
    const listener = (_event: unknown, isMaximized: boolean) =>
      callback(Boolean(isMaximized));
    ipcRenderer.on('window:is-maximized', listener);
    return () => ipcRenderer.removeListener('window:is-maximized', listener);
  },

  api: {
    /**
     * In-process local-api call. `path` looks like `/functions/tud-usage-daily?days=7`.
     * Returns `{ status, body }` where `body` is the envelope JSON.
     */
    request: (
      path: string,
      init?: {
        method?: string;
        body?: string;
        headers?: Record<string, string>;
      },
    ): Promise<{ status: number; body: unknown }> =>
      ipcRenderer.invoke(API_REQUEST_CHANNEL, path, init),
  },

  onDataSynced: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(DATA_SYNCED_CHANNEL, listener);
    return () => ipcRenderer.removeListener(DATA_SYNCED_CHANNEL, listener);
  },

  /**
   * Main → renderer: tray menu / deep-link asks to open settings.
   * Optional `tab` selects the settings panel section.
   * `reloadConfig` asks the settings UI to re-fetch tud-config.
   */
  onOpenSettings: (
    callback: (detail?: {
      tab?: SettingsTabId;
      reloadConfig?: boolean;
      loginSuccess?: boolean;
      loginError?: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, detail: unknown) => {
      if (!detail || typeof detail !== 'object') {
        callback();
        return;
      }
      const raw = detail as {
        tab?: unknown;
        reloadConfig?: unknown;
        loginSuccess?: unknown;
        loginError?: unknown;
      };
      const next: {
        tab?: SettingsTabId;
        reloadConfig?: boolean;
        loginSuccess?: boolean;
        loginError?: string;
      } = {};
      if (raw.tab === 'sync' || raw.tab === 'pet' || raw.tab === 'app') {
        next.tab = raw.tab;
      }
      if (raw.reloadConfig === true) {
        next.reloadConfig = true;
      }
      if (raw.loginSuccess === true) {
        next.loginSuccess = true;
      }
      if (typeof raw.loginError === 'string' && raw.loginError.trim()) {
        next.loginError = raw.loginError.trim();
      }
      callback(next);
    };
    ipcRenderer.on(OPEN_SETTINGS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(OPEN_SETTINGS_CHANNEL, listener);
  },

  /**
   * Main → renderer: deep-link association finished (silent, no settings modal).
   */
  onJuejinLinkResult: (
    callback: (detail: { ok: boolean; message?: string }) => void,
  ) => {
    const listener = (_event: unknown, detail: unknown) => {
      if (!detail || typeof detail !== 'object') {
        callback({ ok: false, message: '关联失败' });
        return;
      }
      const raw = detail as { ok?: unknown; message?: unknown };
      callback({
        ok: raw.ok === true,
        message:
          typeof raw.message === 'string' && raw.message.trim()
            ? raw.message.trim()
            : undefined,
      });
    };
    ipcRenderer.on(JUEJIN_LINK_RESULT_CHANNEL, listener);
    return () =>
      ipcRenderer.removeListener(JUEJIN_LINK_RESULT_CHANNEL, listener);
  },

  onRuntimeNotice: (
    callback: (detail: { kind: 'config-reset'; tokenSalvaged: boolean }) => void,
  ) => {
    const listener = (_event: unknown, detail: unknown) => {
      if (!detail || typeof detail !== 'object') return;
      const raw = detail as { kind?: unknown; tokenSalvaged?: unknown };
      if (raw.kind !== 'config-reset') return;
      callback({
        kind: 'config-reset',
        tokenSalvaged: raw.tokenSalvaged === true,
      });
    };
    ipcRenderer.on(RUNTIME_NOTICE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(RUNTIME_NOTICE_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld('tud', tudApi);

export type TudApi = typeof tudApi;

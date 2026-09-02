/**
 * Ambient global typings shared between preload and renderer.
 *
 * The preload script (src/preload/index.ts) calls
 * `contextBridge.exposeInMainWorld('tud', ...)`; the renderer reads it
 * off `window.tud`. Keeping the contract in a single ambient type makes
 * both ends stay in sync.
 */
declare global {
  interface Window {
    tud: {
      version: () => string;
      platform: NodeJS.Platform;
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      showMainWindow: () => void;
      quit: () => void;
      getAutoUpdateState: () => Promise<import('../shared/auto-update').AutoUpdateState>;
      checkForUpdates: () => Promise<import('../shared/auto-update').AutoUpdateState>;
      acknowledgeUpdateCompleted: () => Promise<void>;
      onAutoUpdateStateChanged: (
        callback: (state: import('../shared/auto-update').AutoUpdateState) => void,
      ) => () => void;
      copyImageToClipboard: (dataUrl: string) => Promise<boolean>;
      openExternal: (
        url: string,
      ) => Promise<{ ok: boolean; message?: string }>;
      resizeTrayPopover: (height: number) => void;
      getDashboardRange: () => Promise<
        import('../shared/dashboard-range').DashboardRange
      >;
      setDashboardRange: (
        range: import('../shared/dashboard-range').DashboardRange,
      ) => Promise<import('../shared/dashboard-range').DashboardRange>;
      onDashboardRange: (
        callback: (range: import('../shared/dashboard-range').DashboardRange) => void,
      ) => () => void;
      getTheme: () => Promise<'light' | 'dark'>;
      setTheme: (theme: 'light' | 'dark') => void;
      onThemeChanged: (callback: (theme: 'light' | 'dark') => void) => () => void;
      getOpenAtLogin: () => Promise<boolean>;
      setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
      getLaunchHidden: () => Promise<boolean>;
      setLaunchHidden: (hidden: boolean) => Promise<boolean>;
      getDesktopPet: () => Promise<{
        enabled: boolean;
        selectedPetId: string;
        position?: { x: number; y: number };
        scale: number;
        frameIntervalMs: number;
        autoMoveEnabled: boolean;
        autoMoveIntervalMinutes: number;
      }>;
      setDesktopPetEnabled: (enabled: boolean) => Promise<boolean>;
      setSelectedDesktopPet: (selectedPetId: string) => Promise<{
        enabled: boolean;
        selectedPetId: string;
        position?: { x: number; y: number };
        scale: number;
        frameIntervalMs: number;
        autoMoveEnabled: boolean;
        autoMoveIntervalMinutes: number;
      }>;
      setDesktopPetPreferences: (changes: {
        scale?: number;
        frameIntervalMs?: number;
        autoMoveEnabled?: boolean;
        autoMoveIntervalMinutes?: number;
      }) => Promise<{
        enabled: boolean;
        selectedPetId: string;
        position?: { x: number; y: number };
        scale: number;
        frameIntervalMs: number;
        autoMoveEnabled: boolean;
        autoMoveIntervalMinutes: number;
      }>;
      setDesktopPetMouseIgnored: (ignored: boolean) => void;
      beginDesktopPetDrag: () => void;
      endDesktopPetDrag: () => void;
      onDesktopPetAnimation: (
        callback: (animation: 'idle' | 'running-left' | 'running-right') => void,
      ) => () => void;
      onDesktopPetPreferences: (callback: (preferences: {
        enabled: boolean;
        selectedPetId: string;
        position?: { x: number; y: number };
        scale: number;
        frameIntervalMs: number;
        autoMoveEnabled: boolean;
        autoMoveIntervalMinutes: number;
      }) => void) => () => void;
      onMaximized: (callback: (isMaximized: boolean) => void) => () => void;
      api: {
        request: (
          path: string,
          init?: {
            method?: string;
            body?: string;
            headers?: Record<string, string>;
          },
        ) => Promise<{ status: number; body: unknown }>;
      };
      onDataSynced: (callback: () => void) => () => void;
      onOpenSettings: (
        callback: (detail?: {
          tab?: 'sync' | 'pet' | 'app';
          reloadConfig?: boolean;
          loginSuccess?: boolean;
          loginError?: string;
        }) => void,
      ) => () => void;
      onJuejinLinkResult: (
        callback: (detail: { ok: boolean; message?: string }) => void,
      ) => () => void;
      onRuntimeNotice: (
        callback: (detail: { kind: 'config-reset'; tokenSalvaged: boolean }) => void,
      ) => () => void;
    };
  }
}

export {};

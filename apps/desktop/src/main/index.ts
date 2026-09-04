import { app, BrowserWindow, clipboard, ipcMain, nativeImage } from 'electron';
import {
  initAutostartOnLaunch,
  registerAutostartIpc,
  shouldStartHidden,
  unregisterAutostartIpc,
} from './autostart';
import {
  DesktopWindow,
  defaultPreloadPath,
  markAppQuitting,
  registerDesktopWindowControls,
  registerOpenExternalIpc,
  resetAppQuitting,
  resolveAppIconPath,
  type DesktopWindowTheme,
  unregisterOpenExternalIpc,
} from './DesktopWindow';
import {
  createTrayPopover,
  disposeTrayPopover,
  hideTrayPopover,
  markTrayPopoverQuitting,
  resetTrayPopoverQuitting,
} from './TrayPopover';
import { registerLocalApiIpc } from './local-api-ipc';
import {
  localApiRequest,
  pokeSyncOnForeground,
  resumeLocalRuntimeWatchdog,
  setLocalRuntimeQuitting,
  startLocalRuntime,
  stopLocalRuntime,
} from './local-runtime';
import {
  disposeDesktopPet,
  registerDesktopPetIpc,
  syncDesktopPet,
  unregisterDesktopPetIpc,
} from './DesktopPet';
import { registerDesktopPetAssetProtocol } from './DesktopPetCatalog';
import {
  applyDeepLinkConfig,
  findDeepLinkInArgv,
  parseDeepLink,
  registerProtocolClient,
  type OpenSettingsPayload,
} from './deep-link';
import { disposeAutoUpdate, initializeAutoUpdate } from './auto-update';
import {
  DEFAULT_DATA_DIR,
  evictRuntimeKind,
  isHeartbeatFresh,
  readRuntimeHeartbeat,
  touchRuntimeHeartbeat,
} from '@juejin-opensource/jusage-core';

type Theme = DesktopWindowTheme;

const THEME_GET_CHANNEL = 'theme:get';
const THEME_SET_CHANNEL = 'theme:set';
const THEME_CHANGED_CHANNEL = 'theme:changed';
const OPEN_SETTINGS_CHANNEL = 'app:open-settings';
const JUEJIN_LINK_RESULT_CHANNEL = 'app:juejin-link-result';
const RUNTIME_NOTICE_CHANNEL = 'app:runtime-notice';
const SHARE_CARD_COPY_IMAGE_CHANNEL = 'share-card:copy-image';

/**
 * jusage-desktop main entry.
 *
 * Starts the shared ~/.ai-usage Core runtime (sync + BucketStore + in-memory
 * local-api), then opens the renderer window.
 */

const windows = new Set<DesktopWindow>();
let disposeLocalApiIpc: (() => void) | null = null;
let currentTheme: Theme = 'light';
let pendingDeepLinkUrl: string | null = null;
let runtimeReady = false;
let pendingConfigResetNotice = false;

async function acquireDesktopInstanceLock(): Promise<boolean> {
  const dir = DEFAULT_DATA_DIR;
  if (!isHeartbeatFresh(await readRuntimeHeartbeat(dir))) {
    console.warn('[tud-desktop] stale desktop heartbeat; evicting leftover instances');
    try {
      await evictRuntimeKind('desktop', {
        exceptPid: process.pid,
        dataDir: dir,
      });
    } catch (err) {
      console.error(
        '[tud-desktop] failed to evict leftover desktop instances:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return app.requestSingleInstanceLock();
}

function broadcastConfigResetNotice(): void {
  pendingConfigResetNotice = false;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(RUNTIME_NOTICE_CHANNEL, {
        kind: 'config-reset',
        tokenSalvaged: false,
      });
    }
  }
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function registerThemeIpc(): void {
  ipcMain.removeHandler(THEME_GET_CHANNEL);
  ipcMain.handle(THEME_GET_CHANNEL, () => currentTheme);

  ipcMain.removeAllListeners(THEME_SET_CHANNEL);
  ipcMain.on(THEME_SET_CHANNEL, (_event, nextTheme: unknown) => {
    if (!isTheme(nextTheme) || nextTheme === currentTheme) return;
    currentTheme = nextTheme;
    for (const desktopWindow of windows) {
      if (desktopWindow.window.isDestroyed()) continue;
      desktopWindow.setThemeBackground(currentTheme);
    }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(THEME_CHANGED_CHANNEL, currentTheme);
    }
  });
}

function registerShareCardIpc(): void {
  ipcMain.removeHandler(SHARE_CARD_COPY_IMAGE_CHANNEL);
  ipcMain.handle(SHARE_CARD_COPY_IMAGE_CHANNEL, (_event, dataUrl: unknown) => {
    if (
      typeof dataUrl !== 'string'
      || !dataUrl.startsWith('data:image/png;base64,')
      || dataUrl.length > 20_000_000
    ) {
      return false;
    }

    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });
}

function getMainWindow(): BrowserWindow | null {
  // destroy() marks the BrowserWindow dead before 'closed' removes the
  // wrapper from the set. Skip (and drop) stale entries so a just-rebuilt
  // window is still found.
  for (const wrapper of [...windows]) {
    const w = wrapper.window;
    if (!w || w.isDestroyed()) {
      windows.delete(wrapper);
      continue;
    }
    return w;
  }
  return null;
}

async function showMainWindowAsync(): Promise<void> {
  // Hide tray popover first so its blur→hide does not race with activation and
  // hand focus back to the previously frontmost app on macOS.
  hideTrayPopover();
  pokeSyncOnForeground();
  const w = getMainWindow();
  if (!w) {
    // Window was destroyed on close (tray-resident app). Rebuild it. On
    // macOS the dock was hidden at close; await the accessory→regular
    // transform so the freshly built window is not hidden by macOS mid-flight.
    if (process.platform === 'darwin' && app.dock && !app.dock.isVisible()) {
      try {
        await app.dock.show();
      } catch {
        // ignore: window is still created below even if the dock stays hidden
      }
    }
    createWindow();
    if (process.platform === 'darwin') {
      // Rebuilt window shows on ready-to-show; activate the app so it lands
      // in the foreground like the existing-window path below.
      app.focus({ steal: true });
    }
    flushPendingConfigResetNotice();
    return;
  }
  if (process.platform === 'darwin' && app.dock && !app.dock.isVisible()) {
    // The dock icon was hidden (accessory mode, set on main-window close).
    // `dock.show()` transforms the activation policy asynchronously and any
    // window shown mid-transform gets hidden by macOS — await it first.
    try {
      await app.dock.show();
    } catch {
      // ignore: window is still shown below even if the dock stays hidden
    }
  }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  flushPendingConfigResetNotice();
}

function showMainWindow(): void {
  void showMainWindowAsync();
}

/** Same as in-app / tray「同步数据」→ POST tud-trigger-sync. */
function triggerSync(): void {
  void localApiRequest('/functions/tud-trigger-sync', {
    method: 'POST',
    body: '{}',
  }).catch((err) => {
    console.error(
      '[tud-desktop] sync failed:',
      err instanceof Error ? err.message : err,
    );
  });
}

/** After a tray rebuild the page may still be loading, and SettingsPanel
 *  only subscribes in useEffect — wait for both before sending IPC. */
function sendToMainWindowWhenReady(
  w: BrowserWindow,
  send: (window: BrowserWindow) => void,
): void {
  let sent = false;
  const fire = () => {
    if (sent || w.isDestroyed()) return;
    sent = true;
    // Small delay so AppShell's listeners are attached after first paint.
    setTimeout(() => {
      if (!w.isDestroyed()) send(w);
    }, 50);
  };
  if (w.webContents.isLoading()) {
    w.webContents.once('did-finish-load', fire);
    // Load can finish between isLoading() and once(); don't hang.
    if (!w.webContents.isLoading()) fire();
    return;
  }
  fire();
}

function flushPendingConfigResetNotice(): void {
  if (!pendingConfigResetNotice) return;
  const main = getMainWindow();
  if (!main) return;
  sendToMainWindowWhenReady(main, () => broadcastConfigResetNotice());
}

async function openSettings(detail?: OpenSettingsPayload): Promise<void> {
  await showMainWindowAsync();
  const w = getMainWindow();
  if (!w) return;
  sendToMainWindowWhenReady(w, (window) => {
    window.webContents.send(OPEN_SETTINGS_CHANNEL, detail ?? {});
  });
}

/** Silent login callback: focus window + notify renderer (no settings modal). */
async function notifyJuejinLinkResult(detail: {
  ok: boolean;
  message?: string;
}): Promise<void> {
  await showMainWindowAsync();
  const w = getMainWindow();
  if (!w) return;
  sendToMainWindowWhenReady(w, (window) => {
    window.webContents.send(JUEJIN_LINK_RESULT_CHANNEL, detail);
  });
}

async function handleDeepLinkUrl(raw: string): Promise<void> {
  const payload = parseDeepLink(raw);
  if (!payload) {
    console.warn('[tud-desktop] ignored invalid deep link:', raw);
    // Avoid createWindow before app.whenReady (macOS open-url can be early).
    if (runtimeReady || getMainWindow()) {
      void notifyJuejinLinkResult({
        ok: false,
        message: '无效的关联链接',
      });
    }
    return;
  }

  if (!runtimeReady) {
    pendingDeepLinkUrl = raw;
    return;
  }

  const result = await applyDeepLinkConfig(payload);
  if (!result.ok) {
    console.warn(
      '[tud-desktop] deep-link config apply failed:',
      result.message ?? 'unknown',
    );
  }
  // Silent association (same as CLI): no settings modal. Renderer hides
  // 「关联掘金」via link-changed event; optional toast for success/failure.
  void notifyJuejinLinkResult({
    ok: result.ok,
    message: result.ok
      ? undefined
      : (result.message ?? '关联失败'),
  });
}

function createWindow(opts?: { startHidden?: boolean }): void {
  const w = new DesktopWindow({
    preloadPath: defaultPreloadPath(),
    theme: currentTheme,
    title: 'Juejin Usage',
    startHidden: opts?.startHidden,
  });
  windows.add(w);
  w.window.on('closed', () => windows.delete(w));
}

/** Dev/preview runs Electron.app itself — override Dock so it is not the default atom. */
function applyDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return;
  const image = nativeImage.createFromPath(resolveAppIconPath());
  if (image.isEmpty()) return;
  app.dock?.setIcon(image);
}

// Single-instance + protocol must be registered before ready.
// Evict hung leftovers first so we can take the lock without quitting
// the electron-vite child (exit 143).
void acquireDesktopInstanceLock().then((gotLock) => {
  if (!gotLock) {
    app.quit();
    return;
  }

  registerProtocolClient();

  app.on('second-instance', (_event, argv) => {
    const url = findDeepLinkInArgv(argv);
    if (url) {
      void handleDeepLinkUrl(url);
      return;
    }
    showMainWindow();
  });

  // macOS: open-url may fire before ready — queue until runtime is up.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    void handleDeepLinkUrl(url);
  });

  // Windows cold start: deep link may be in process.argv.
  const coldStartUrl = findDeepLinkInArgv(process.argv);
  if (coldStartUrl) {
    pendingDeepLinkUrl = coldStartUrl;
  }

  app.whenReady().then(async () => {
    registerDesktopPetAssetProtocol();
    applyDevDockIcon();
    ipcMain.removeAllListeners('app:quit');
    ipcMain.on('app:quit', () => app.quit());

    registerDesktopWindowControls(() => getMainWindow(), {
      onShow: showMainWindow,
    });
    registerOpenExternalIpc();
    registerThemeIpc();
    registerShareCardIpc();
    registerAutostartIpc();
    registerDesktopPetIpc({
      showMainWindow,
      openSettings: () => {
        void openSettings({ tab: 'pet' });
      },
      triggerSync,
    });
    disposeLocalApiIpc = registerLocalApiIpc();
    await initializeAutoUpdate({
      beforeInstall: async () => {
        // Release close interceptors before stopping runtime so a hung stop
        // cannot leave tray/main-window preventDefault blocking quit.
        hideTrayPopover();
        markTrayPopoverQuitting();
        markAppQuitting();
        setLocalRuntimeQuitting(true);
        await stopLocalRuntime();
      },
      onInstallFailed: async () => {
        resetAppQuitting();
        resetTrayPopoverQuitting();
        resumeLocalRuntimeWatchdog();
        await startLocalRuntime();
        // quitAndInstall may have already destroyed the main window.
        showMainWindow();
      },
    });

    try {
      await initAutostartOnLaunch();
    } catch (err) {
      console.error(
        '[tud-desktop] failed to init autostart:',
        err instanceof Error ? err.message : err,
      );
    }

    try {
      await touchRuntimeHeartbeat({ kind: 'desktop', pid: process.pid });
      const started = await startLocalRuntime();
      runtimeReady = true;
      if (
        started.recoveredFromCorrupt &&
        !started.recoveredFromCorrupt.tokenSalvaged
      ) {
        pendingConfigResetNotice = true;
      }
    } catch (err) {
      console.error(
        '[tud-desktop] failed to start local runtime:',
        err instanceof Error ? err.message : err,
      );
    }
    resumeLocalRuntimeWatchdog();

    // Login autostart (openAsHidden): stay tray-only. Creating a window just
    // to destroy it on ready-to-show still pays for a full dashboard load and
    // drops IPC (config-reset / deep-link) aimed at that doomed window.
    if (shouldStartHidden()) {
      if (process.platform === 'darwin') {
        app.dock?.hide();
      }
    } else {
      createWindow();
      flushPendingConfigResetNotice();
    }
    await syncDesktopPet();
    createTrayPopover({
      showMainWindow,
      openSettings: () => openSettings(),
      triggerSync,
    });

    if (pendingDeepLinkUrl) {
      const url = pendingDeepLinkUrl;
      pendingDeepLinkUrl = null;
      if (runtimeReady) {
        void handleDeepLinkUrl(url);
      } else {
        void notifyJuejinLinkResult({
          ok: false,
          message: '本地服务未就绪，无法完成关联',
        });
      }
    }

    app.on('activate', () => {
      // macOS emits activate at login launch as well as dock-click. A silent
      // login start has no window yet; creating one here would undo tray-only
      // startup. Dock is hidden in that mode — later opens go through the tray.
      if (shouldStartHidden() && !getMainWindow()) return;
      showMainWindow();
    });

    // User clicked back into an already-visible window (alt-tab etc.):
    // restore the fast poll cadence and refresh stale data.
    app.on('browser-window-focus', () => {
      pokeSyncOnForeground();
    });
  });

  // Stay alive in the tray when all windows are closed/hidden.
  // Real exit is via tray "退出" or app:quit.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    markAppQuitting();
    setLocalRuntimeQuitting(true);
    ipcMain.removeHandler(THEME_GET_CHANNEL);
    ipcMain.removeHandler(SHARE_CARD_COPY_IMAGE_CHANNEL);
    ipcMain.removeAllListeners(THEME_SET_CHANNEL);
    unregisterOpenExternalIpc();
    unregisterAutostartIpc();
    unregisterDesktopPetIpc();
    disposeDesktopPet();
    disposeTrayPopover();
    disposeLocalApiIpc?.();
    disposeLocalApiIpc = null;
    disposeAutoUpdate();
    void stopLocalRuntime();
  });
});

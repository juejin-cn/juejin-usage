import { BrowserWindow, Menu, app, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DesktopWindowOptions {
  preloadPath: string;
  theme?: DesktopWindowTheme;
  title?: string;
  /** When true (login openAsHidden), stay in tray — do not show on ready-to-show. */
  startHidden?: boolean;
}

export type DesktopWindowTheme = 'dark' | 'light';

const WINDOW_BACKGROUND_COLORS: Record<DesktopWindowTheme, string> = {
  dark: '#050607',
  light: '#f5f5f5',
};

const isMac = process.platform === 'darwin';
const MAIN_WINDOW_WIDTH = 1024;
const MAIN_WINDOW_HEIGHT = 780;
const MAIN_WINDOW_MIN_WIDTH = 800;
const MAIN_WINDOW_MIN_HEIGHT = 600;

/** Set in `before-quit` so close handlers destroy windows instead of hiding. */
let appIsQuitting = false;

export function markAppQuitting(): void {
  appIsQuitting = true;
}

/** Restore close-to-tray behavior if an attempted update install fails. */
export function resetAppQuitting(): void {
  appIsQuitting = false;
}

/**
 * App icon for unpackaged runs (`electron-vite dev` / preview).
 * Packaged builds get the icon from electron-builder into the .app / .exe;
 * here we still point at `resources/` so Win/Linux window+taskbar use it in
 * dev. macOS Dock needs a separate `app.dock.setIcon` call (see index.ts).
 */
export function resolveAppIconPath(): string {
  return path.join(__dirname, '../../resources/icon.png');
}

/**
 * DesktopWindow
 *
 * Single window host for jusage-desktop.
 *
 * Window customization:
 *  1. macOS uses `titleBarStyle: hidden` to remove the title bar while keeping
 *     the native traffic lights over the renderer-owned window surface.
 *  2. Windows / Linux use `frame: false` to remove all native chrome.
 *  3. 应用菜单 `null`，单窗 `autoHideMenuBar: true` — 不占用渲染区域。
 *  4. 注册 `window:minimize / toggle-maximize / close` IPC 监听；
 *     转发 maximize / unmaximize 事件到渲染层，更新图标状态。
 *  5. 点关闭按钮销毁窗口（托盘保活），真正退出由托盘菜单触发。
 *
 * `main/index.ts` 仅负责 app 生命周期。
 */
export class DesktopWindow {
  private readonly browserWindow: BrowserWindow;

  constructor(options: DesktopWindowOptions) {
    // Remove application-level native menu. Per-window menu bar is hidden
    // by `autoHideMenuBar`. The custom menu lives in the renderer.
    if (Menu.getApplicationMenu() !== null) {
      Menu.setApplicationMenu(null);
    }

    this.browserWindow = new BrowserWindow({
      width: MAIN_WINDOW_WIDTH,
      height: MAIN_WINDOW_HEIGHT,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
      // Windows/Linux are frameless, so the renderer supplies the native-like
      // title controls. Keep the window resizable and maximizable so the
      // maximize control is functional instead of decorative.
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      show: false,
      frame: isMac,
      titleBarStyle: isMac ? 'hidden' : 'default',
      trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
      autoHideMenuBar: true,
      backgroundColor: WINDOW_BACKGROUND_COLORS[options.theme ?? 'light'],
      title: options.title ?? 'Juejin Usage',
      // Win/Linux only in practice; macOS Dock ignores BrowserWindow.icon.
      icon: resolveAppIconPath(),
      webPreferences: {
        preload: options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (isMac) {
      this.browserWindow.setWindowButtonVisibility(true);
    }

    // Close (X / traffic light) destroys the window and frees its renderer
    // process — the app stays alive in the tray and rebuilds the window on
    // demand (see index.ts showMainWindowAsync). Real exit goes through
    // tray "退出" / app:quit which sets appIsQuitting first.
    this.browserWindow.on('close', (e) => {
      if (appIsQuitting) return;
      e.preventDefault();
      this.browserWindow.destroy();
      if (isMac) {
        app.dock?.hide();
      }
    });

    this.browserWindow.on('ready-to-show', () => {
      if (options.startHidden) {
        // Start hidden (login autostart): destroy the window like close-to-
        // tray does, so no renderer process stays resident. Rebuild on tray
        // click via showMainWindowAsync.
        this.browserWindow.destroy();
        if (isMac) {
          app.dock?.hide();
        }
        return;
      }
      this.browserWindow.show();
      // Push current maximize state on first show so the renderer can paint
      // the right control icon immediately.
      this.browserWindow.webContents.send(
        'window:is-maximized',
        this.browserWindow.isMaximized(),
      );
    });

    // Keep the renderer's control icon in sync with OS state — fires for
    // external maximize events (drag-to-edge snap, keyboard, etc.), not
    // just clicks on our own button.
    this.browserWindow.on('maximize', () => {
      this.browserWindow.webContents.send('window:is-maximized', true);
    });
    this.browserWindow.on('unmaximize', () => {
      this.browserWindow.webContents.send('window:is-maximized', false);
    });

    if (!app.isPackaged) {
      // Application menu is null, so Electron's default View → Toggle
      // Developer Tools (Cmd+Option+I / Ctrl+Shift+I) is gone. Rebind
      // the common shortcuts here; F12 still works (Fn+F12 on many Macs).
      this.browserWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !isDevToolsToggle(input)) return;
        if (this.browserWindow.webContents.isDevToolsOpened()) {
          this.browserWindow.webContents.closeDevTools();
        } else {
          this.browserWindow.webContents.openDevTools({ mode: 'detach' });
        }
        event.preventDefault();
      });
    }

    // External links open in OS default browser, not inside the app.
    this.browserWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    void this.loadRenderer();
  }

  /** dev 模式由 electron-vite 注入 URL；生产模式加载本地静态文件 */
  private async loadRenderer(): Promise<void> {
    try {
      const devUrl = process.env['ELECTRON_RENDERER_URL'];
      if (!app.isPackaged && devUrl) {
        await this.browserWindow.loadURL(devUrl);
        return;
      }
      await this.browserWindow.loadFile(
        path.join(__dirname, '../renderer/index.html'),
      );
    } catch (err) {
      // Close-to-tray destroy() aborts an in-flight load; same as the pet window.
      if (this.browserWindow.isDestroyed()) return;
      throw err;
    }
  }

  get window(): BrowserWindow {
    return this.browserWindow;
  }

  setThemeBackground(theme: DesktopWindowTheme): void {
    this.browserWindow.setBackgroundColor(WINDOW_BACKGROUND_COLORS[theme]);
  }
}

export function defaultPreloadPath(): string {
  return path.join(__dirname, '../preload/index.js');
}

function isDevToolsToggle(input: Electron.Input): boolean {
  if (input.key === 'F12') return true;
  const key = input.key.toLowerCase();
  // Chrome / Electron defaults: Cmd+Option+I (mac) / Ctrl+Shift+I (win/linux).
  if (key !== 'i') return false;
  if (isMac) return input.meta && input.alt;
  return input.control && input.shift;
}

/* ──────────────────────────────────────────────────────────────────────
 * IPC handlers — registered once per process. Re-registration would
 * throw in development under Electron's "allow only one handler per
 * channel" guard. `removeHandler` makes the function idempotent.
 * ──────────────────────────────────────────────────────────────────── */
function registerWindowControlHandlers(
  getWindow: () => BrowserWindow | null,
  options?: { onShow?: () => void },
): void {
  ipcMain.removeHandler('window:minimize');
  ipcMain.removeHandler('window:toggle-maximize');
  ipcMain.removeHandler('window:close');
  ipcMain.removeAllListeners('window:show');

  ipcMain.on('window:minimize', () => {
    getWindow()?.minimize();
  });

  ipcMain.on('window:toggle-maximize', () => {
    const w = getWindow();
    if (!w || !w.isMaximizable()) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });

  ipcMain.on('window:close', () => {
    getWindow()?.close();
  });

  ipcMain.on('window:show', () => {
    if (options?.onShow) {
      options.onShow();
      return;
    }
    void (async () => {
      const w = getWindow();
      if (!w) return;
      if (process.platform === 'darwin' && app.dock && !app.dock.isVisible()) {
        // Await the accessory→regular transform; showing a window while it is
        // in flight gets the window hidden by macOS.
        try {
          await app.dock.show();
        } catch {
          // ignore
        }
      }
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    })();
  });
}

const OPEN_EXTERNAL_CHANNEL = 'shell:open-external';

/**
 * Open http(s) URLs in the OS default browser. Used by「掘金登录」so we do not
 * depend on `window.open` → `setWindowOpenHandler` (unreliable with sandbox + noopener).
 */
export function registerOpenExternalIpc(): void {
  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { ok: false as const, message: 'INVALID_URL' };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false as const, message: 'INVALID_URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false as const, message: 'INVALID_PROTOCOL' };
    }
    try {
      await shell.openExternal(parsed.toString());
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        message: err instanceof Error ? err.message : 'OPEN_FAILED',
      };
    }
  });
}

export function unregisterOpenExternalIpc(): void {
  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
}

/**
 * Wire up window-control IPC. Called from `main/index.ts` after `app.whenReady`
 * so that `getWindow` resolves to the current window.
 *
 * Pass `onShow` to reuse the app-level show/focus path (hide tray popover,
 * steal focus on macOS) instead of a bare `BrowserWindow.show()`.
 */
export function registerDesktopWindowControls(
  getWindow: () => BrowserWindow | null,
  options?: { onShow?: () => void },
): void {
  registerWindowControlHandlers(getWindow, options);
}

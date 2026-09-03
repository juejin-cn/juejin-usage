import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  ipcMain,
  nativeImage,
  screen,
} from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultPreloadPath, resolveAppIconPath } from './DesktopWindow';
import { pokeSyncOnForeground } from './local-runtime';

/**
 * TrayPopover
 *
 * Cross-platform system tray / menu-bar icon.
 *
 * 设计要点：
 *  - 全平台创建 Tray；关窗后进程靠托盘保活，右键菜单提供「显示主窗口」「同步数据」「退出」。
 *  - macOS：左键切换 Popover；右键手动 popUpContextMenu（不可 setContextMenu，
 *    否则 Electron 会让左键也弹菜单）。图标用 Template Image（`juejinTemplate.png`）。
 *  - Win/Linux：左键显示主窗口；setContextMenu 处理右键；图标用 `icon.png`。
 *  - Popover（仅 macOS）是独立无边框 BrowserWindow，通过 tray.getBounds()
 *    定位；失焦自动隐藏。
 *  - 应用退出时清理 tray 与窗口，避免残留。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isMac = process.platform === 'darwin';

const TRAY_POPOVER_RESIZE_CHANNEL = 'tray-popover:resize';

const POPOVER_WIDTH = 420;
const POPOVER_MIN_HEIGHT = 200;
const POPOVER_MAX_HEIGHT = 700;
/** Initial height; the renderer reports its real content height on first paint. */
const POPOVER_INITIAL_HEIGHT = POPOVER_MIN_HEIGHT;
const POPOVER_MARGIN = 6;

export interface TrayPopoverOptions {
  showMainWindow: () => void;
  openSettings: () => void;
  /** Same as in-app「同步数据」→ POST tud-trigger-sync. */
  triggerSync: () => void;
}

let tray: Tray | null = null;
let popover: BrowserWindow | null = null;
let isQuitting = false;
/** Latest content height reported by the renderer, used when re-anchoring. */
let popoverHeight = POPOVER_INITIAL_HEIGHT;

function resolveTrayIconPath(): string {
  const file = isMac ? 'juejinTemplate.png' : 'icon.png';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', file);
  }
  if (isMac) {
    return path.join(app.getAppPath(), 'resources', file);
  }
  return resolveAppIconPath();
}

function loadTrayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(resolveTrayIconPath());
  if (img.isEmpty()) {
    console.warn('[tud-desktop] tray icon not found, using empty image');
    return img;
  }
  if (isMac) {
    img.setTemplateImage(true);
  }
  return img;
}

function buildTrayMenu(options: TrayPopoverOptions): Menu {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => options.showMainWindow(),
    },
    {
      label: '同步数据',
      click: () => options.triggerSync(),
    },
    {
      label: '设置',
      click: () => options.openSettings(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]);
}

function ensurePopover(): BrowserWindow {
  if (popover && !popover.isDestroyed()) return popover;

  popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_INITIAL_HEIGHT,
    minWidth: POPOVER_WIDTH,
    maxWidth: POPOVER_WIDTH,
    minHeight: POPOVER_INITIAL_HEIGHT,
    maxHeight: POPOVER_INITIAL_HEIGHT,
    show: false,
    frame: false,
    fullscreenable: false,
    // Keep native resizing enabled for programmatic auto-height updates. The
    // active height is locked with equal min/max bounds after every update.
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: defaultPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popover.webContents.on('context-menu', (e) => e.preventDefault());
  popover.on('blur', () => popover?.hide());
  popover.on('close', (e) => {
    // Hide instead of destroy on user close to allow re-toggling.
    if (!isQuitting) {
      e.preventDefault();
      popover?.hide();
    }
  });

  void loadPopoverRenderer(popover);

  return popover;
}

async function loadPopoverRenderer(window: BrowserWindow): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    const url = new URL(devUrl);
    url.searchParams.set('view', 'tray-popover');
    await window.loadURL(url.toString());
    return;
  }

  await window.loadFile(path.join(__dirname, '../renderer/index.html'), {
    search: '?view=tray-popover',
  });
}

/**
 * Anchor the popover to the tray icon at `height`.
 *
 * Called both on show and whenever the renderer reports a new content height,
 * so a growing popover stays pinned under the tray icon instead of drifting or
 * spilling off the bottom of the work area.
 */
function positionPopoverNearTray(t: Tray, height: number): void {
  if (!popover) return;
  const bounds = t.getBounds();
  if (bounds.width === 0 && bounds.height === 0) return;

  const display = screen.getDisplayNearestPoint({
    x: bounds.x,
    y: bounds.y,
  });
  const work = display.workArea;

  // Never taller than the work area itself, regardless of the content cap.
  const h = Math.min(height, work.height - POPOVER_MARGIN * 2);

  // macOS needs a resizable window for `setBounds` height updates. Temporarily
  // unlock the height, apply the measured size, then lock it again so users
  // cannot drag any popover edge to resize it.
  popover.setMinimumSize(POPOVER_WIDTH, POPOVER_MIN_HEIGHT);
  popover.setMaximumSize(POPOVER_WIDTH, POPOVER_MAX_HEIGHT);

  let x = Math.round(
    bounds.x + bounds.width / 2 - POPOVER_WIDTH / 2,
  );
  let y: number;
  if (bounds.y < work.y + work.height / 2) {
    y = bounds.y + bounds.height + POPOVER_MARGIN;
  } else {
    y = bounds.y - h - POPOVER_MARGIN;
  }

  const minX = work.x + POPOVER_MARGIN;
  const maxX = work.x + work.width - POPOVER_WIDTH - POPOVER_MARGIN;
  x = Math.max(minX, Math.min(x, maxX));

  const minY = work.y + POPOVER_MARGIN;
  const maxY = work.y + work.height - h - POPOVER_MARGIN;
  y = Math.max(minY, Math.min(y, Math.max(minY, maxY)));

  popover.setBounds({
    x,
    y,
    width: POPOVER_WIDTH,
    height: Math.round(h),
  });
  popover.setMinimumSize(POPOVER_WIDTH, Math.round(h));
  popover.setMaximumSize(POPOVER_WIDTH, Math.round(h));
}

function handlePopoverResize(
  event: Electron.IpcMainEvent,
  rawHeight: unknown,
): void {
  if (!popover || popover.isDestroyed() || !tray) return;
  // Only the popover's own contents may drive its bounds.
  if (event.sender !== popover.webContents) return;

  const height = Number(rawHeight);
  if (!Number.isFinite(height)) return;

  const clamped = Math.round(
    Math.min(Math.max(height, POPOVER_MIN_HEIGHT), POPOVER_MAX_HEIGHT),
  );
  if (clamped === popoverHeight) return;
  popoverHeight = clamped;
  positionPopoverNearTray(tray, clamped);
}

function togglePopover(): void {
  if (!tray) return;
  const w = ensurePopover();
  if (w.isVisible()) {
    w.hide();
    return;
  }
  pokeSyncOnForeground();
  positionPopoverNearTray(tray, popoverHeight);
  w.show();
  w.focus();
}

/** Hide the macOS tray popover if visible (e.g. before focusing the main window). */
export function hideTrayPopover(): void {
  if (!popover || popover.isDestroyed() || !popover.isVisible()) return;
  popover.hide();
}

/** Allow electron-updater to close the popover instead of hide-on-close. */
export function markTrayPopoverQuitting(): void {
  isQuitting = true;
}

/** Restore hide-on-close if an attempted update install fails. */
export function resetTrayPopoverQuitting(): void {
  isQuitting = false;
}

export function createTrayPopover(options: TrayPopoverOptions): void {
  if (tray) return;

  tray = new Tray(loadTrayIcon());
  tray.setToolTip('Juejin Usage');
  const menu = buildTrayMenu(options);

  if (isMac) {
    tray.on('click', () => togglePopover());
    tray.on('right-click', () => tray?.popUpContextMenu(menu));
    ipcMain.removeAllListeners(TRAY_POPOVER_RESIZE_CHANNEL);
    ipcMain.on(TRAY_POPOVER_RESIZE_CHANNEL, handlePopoverResize);
  } else {
    tray.setContextMenu(menu);
    tray.on('click', () => options.showMainWindow());
  }
}

export function disposeTrayPopover(): void {
  isQuitting = true;
  ipcMain.removeAllListeners(TRAY_POPOVER_RESIZE_CHANNEL);
  if (popover && !popover.isDestroyed()) {
    popover.removeAllListeners('blur');
    popover.removeAllListeners('close');
    popover.destroy();
  }
  popover = null;

  if (tray && !tray.isDestroyed()) {
    tray.removeAllListeners('click');
    tray.removeAllListeners('right-click');
    tray.destroy();
  }
  tray = null;
}

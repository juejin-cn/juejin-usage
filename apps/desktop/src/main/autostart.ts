/**
 * Desktop open-at-login preference + OS login item registration.
 *
 * Preference lives in Electron userData (not ~/.ai-usage/config.json).
 * setLoginItemSettings only runs when packaged so `electron-vite dev`
 * does not register the Electron binary itself.
 */
import { BrowserWindow, app, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DASHBOARD_RANGE_CHANGED_CHANNEL,
  DASHBOARD_RANGE_GET_CHANNEL,
  DASHBOARD_RANGE_SET_CHANNEL,
  DEFAULT_DASHBOARD_RANGE,
  isDashboardRange,
  type DashboardRange,
} from '../shared/dashboard-range';

const AUTOSTART_GET_CHANNEL = 'autostart:get';
const AUTOSTART_SET_CHANNEL = 'autostart:set';
const AUTOSTART_GET_HIDDEN_CHANNEL = 'autostart:get-hidden';
const AUTOSTART_SET_HIDDEN_CHANNEL = 'autostart:set-hidden';

export interface DesktopPetPosition {
  x: number;
  y: number;
}

export interface DesktopPetPref {
  enabled: boolean;
  selectedPetId: string;
  position?: DesktopPetPosition;
  scale: number;
  frameIntervalMs: number;
  autoMoveEnabled: boolean;
  autoMoveIntervalMinutes: number;
}

export const DEFAULT_DESKTOP_PET_SCALE = 0.5;
export const DEFAULT_DESKTOP_PET_FRAME_INTERVAL_MS = 180;
export const DEFAULT_DESKTOP_PET_AUTO_MOVE_ENABLED = true;
export const DEFAULT_DESKTOP_PET_AUTO_MOVE_INTERVAL_MINUTES = 2;

interface DesktopPrefs {
  openAtLogin: boolean;
  /** 开机自启时是否静默启动（仅托盘，不显示主窗口）。默认开启。 */
  launchHidden: boolean;
  desktopPet?: DesktopPetPref;
  /**
   * Last dashboard time range. Stored here so the pet window can follow it;
   * pet.html does not share the dashboard renderer's localStorage origin.
   */
  dashboardRange?: DashboardRange;
}

export interface AutostartPref {
  openAtLogin: boolean;
  isFirstRun: boolean;
  launchHidden: boolean;
}

function prefsPath(): string {
  return join(app.getPath('userData'), 'desktop-prefs.json');
}

async function readPrefsFile(): Promise<DesktopPrefs | null> {
  const path = prefsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DesktopPrefs>;
    if (typeof parsed.openAtLogin !== 'boolean') return null;
    const desktopPet = parsed.desktopPet;
    const hasValidPosition = desktopPet?.position
      && Number.isFinite(desktopPet.position.x)
      && Number.isFinite(desktopPet.position.y);
    return {
      openAtLogin: parsed.openAtLogin,
      launchHidden: typeof parsed.launchHidden === 'boolean'
        ? parsed.launchHidden
        : true,
      dashboardRange: isDashboardRange(parsed.dashboardRange)
        ? parsed.dashboardRange
        : undefined,
      desktopPet: desktopPet && typeof desktopPet.enabled === 'boolean'
        ? {
            enabled: desktopPet.enabled,
            selectedPetId: typeof desktopPet.selectedPetId === 'string'
              ? desktopPet.selectedPetId
              : 'hawking',
            ...(hasValidPosition ? { position: desktopPet.position } : {}),
            scale: isDesktopPetScale(desktopPet.scale)
              ? desktopPet.scale
              : DEFAULT_DESKTOP_PET_SCALE,
            frameIntervalMs: isDesktopPetFrameInterval(desktopPet.frameIntervalMs)
              ? desktopPet.frameIntervalMs
              : DEFAULT_DESKTOP_PET_FRAME_INTERVAL_MS,
            autoMoveEnabled: typeof desktopPet.autoMoveEnabled === 'boolean'
              ? desktopPet.autoMoveEnabled
              : DEFAULT_DESKTOP_PET_AUTO_MOVE_ENABLED,
            autoMoveIntervalMinutes: isDesktopPetAutoMoveInterval(desktopPet.autoMoveIntervalMinutes)
              ? desktopPet.autoMoveIntervalMinutes
              : DEFAULT_DESKTOP_PET_AUTO_MOVE_INTERVAL_MINUTES,
          }
        : undefined,
    };
  } catch {
    return null;
  }
}

async function writePrefs(prefs: DesktopPrefs): Promise<void> {
  await writeFile(prefsPath(), `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
}

async function patchPrefs(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs> {
  const existing = await readPrefsFile();
  const next: DesktopPrefs = {
    openAtLogin: patch.openAtLogin ?? existing?.openAtLogin ?? true,
    launchHidden: patch.launchHidden ?? existing?.launchHidden ?? true,
    desktopPet: patch.desktopPet !== undefined ? patch.desktopPet : existing?.desktopPet,
    dashboardRange: patch.dashboardRange !== undefined
      ? patch.dashboardRange
      : existing?.dashboardRange,
  };
  await writePrefs(next);
  return next;
}

function broadcastDashboardRange(range: DashboardRange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DASHBOARD_RANGE_CHANGED_CHANNEL, range);
    }
  }
}

/** Frozen at init: was *this* process started as a silent login launch? */
let silentThisLaunch = false;

function setOsLoginItem(enabled: boolean, launchHidden: boolean): void {
  if (!app.isPackaged) return;
  // Windows: openAsHidden is ignored; --hidden is the real signal.
  // macOS 13+ SMAppService also ignores openAsHidden (wasOpenedAsHidden stays
  // false). Pass --hidden on every platform and still set openAsHidden for
  // older macOS login-item APIs.
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: launchHidden,
    args: launchHidden ? ['--hidden'] : [],
  });
}

export async function loadAutostartPref(): Promise<AutostartPref> {
  const existing = await readPrefsFile();
  if (!existing) {
    return { openAtLogin: true, isFirstRun: true, launchHidden: true };
  }
  return {
    openAtLogin: existing.openAtLogin,
    isFirstRun: false,
    launchHidden: existing.launchHidden,
  };
}

export async function applyAutostart(
  enabled: boolean,
  launchHidden?: boolean,
): Promise<boolean> {
  const existing = await readPrefsFile();
  const hidden = launchHidden ?? existing?.launchHidden ?? true;
  await patchPrefs({
    openAtLogin: enabled,
    launchHidden: hidden,
  });
  setOsLoginItem(enabled, hidden);
  return enabled;
}

/** 读取「开机静默启动」偏好，默认开启。 */
export async function loadLaunchHidden(): Promise<boolean> {
  const existing = await readPrefsFile();
  return existing?.launchHidden ?? true;
}

/** 切换「开机静默启动」偏好并同步到系统登录项。 */
export async function setLaunchHidden(hidden: boolean): Promise<boolean> {
  const existing = await readPrefsFile();
  const openAtLogin = existing?.openAtLogin ?? true;
  await patchPrefs({
    openAtLogin,
    launchHidden: hidden,
  });
  setOsLoginItem(openAtLogin, hidden);
  return hidden;
}

export async function loadDesktopPetPref(): Promise<DesktopPetPref> {
  const existing = await readPrefsFile();
  return existing?.desktopPet ?? {
    enabled: false,
    selectedPetId: 'hawking',
    scale: DEFAULT_DESKTOP_PET_SCALE,
    frameIntervalMs: DEFAULT_DESKTOP_PET_FRAME_INTERVAL_MS,
    autoMoveEnabled: DEFAULT_DESKTOP_PET_AUTO_MOVE_ENABLED,
    autoMoveIntervalMinutes: DEFAULT_DESKTOP_PET_AUTO_MOVE_INTERVAL_MINUTES,
  };
}

export async function saveDesktopPetPref(pref: DesktopPetPref): Promise<DesktopPetPref> {
  await patchPrefs({ desktopPet: pref });
  return pref;
}

export async function loadDashboardRange(): Promise<DashboardRange> {
  const existing = await readPrefsFile();
  return existing?.dashboardRange ?? DEFAULT_DASHBOARD_RANGE;
}

export async function saveDashboardRange(range: DashboardRange): Promise<DashboardRange> {
  const current = await loadDashboardRange();
  if (current === range) return range;
  await patchPrefs({ dashboardRange: range });
  broadcastDashboardRange(range);
  return range;
}

function isDesktopPetScale(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.35 && value <= 0.75;
}

function isDesktopPetFrameInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 120 && value <= 320;
}

function isDesktopPetAutoMoveInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 120;
}

/** First launch: enable + register. Later: re-apply stored preference. */
export async function initAutostartOnLaunch(): Promise<boolean> {
  const pref = await loadAutostartPref();
  if (pref.isFirstRun) {
    await applyAutostart(true);
    silentThisLaunch = detectSilentThisLaunch(true);
    return true;
  }
  setOsLoginItem(pref.openAtLogin, pref.launchHidden);
  silentThisLaunch = detectSilentThisLaunch(pref.launchHidden);
  return pref.openAtLogin;
}

function detectSilentThisLaunch(launchHidden: boolean): boolean {
  if (!app.isPackaged) return false;
  if (process.argv.includes('--hidden')) return true;
  try {
    if (process.platform !== 'darwin') return false;
    const settings = app.getLoginItemSettings();
    if (settings.wasOpenedAsHidden) return true;
    return Boolean(settings.wasOpenedAtLogin) && launchHidden;
  } catch {
    return false;
  }
}

/** True when *this* process was launched as a tray-only login item. */
export function shouldStartHidden(): boolean {
  return silentThisLaunch;
}

export function registerAutostartIpc(): void {
  ipcMain.removeHandler(AUTOSTART_GET_CHANNEL);
  ipcMain.handle(AUTOSTART_GET_CHANNEL, async () => {
    const pref = await loadAutostartPref();
    return pref.openAtLogin;
  });

  ipcMain.removeHandler(AUTOSTART_SET_CHANNEL);
  ipcMain.handle(AUTOSTART_SET_CHANNEL, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new Error('openAtLogin must be a boolean');
    }
    return applyAutostart(enabled);
  });

  ipcMain.removeHandler(AUTOSTART_GET_HIDDEN_CHANNEL);
  ipcMain.handle(AUTOSTART_GET_HIDDEN_CHANNEL, async () => loadLaunchHidden());

  ipcMain.removeHandler(AUTOSTART_SET_HIDDEN_CHANNEL);
  ipcMain.handle(AUTOSTART_SET_HIDDEN_CHANNEL, async (_event, hidden: unknown) => {
    if (typeof hidden !== 'boolean') {
      throw new Error('launchHidden must be a boolean');
    }
    return setLaunchHidden(hidden);
  });

  ipcMain.removeHandler(DASHBOARD_RANGE_GET_CHANNEL);
  ipcMain.handle(DASHBOARD_RANGE_GET_CHANNEL, () => loadDashboardRange());

  ipcMain.removeHandler(DASHBOARD_RANGE_SET_CHANNEL);
  ipcMain.handle(DASHBOARD_RANGE_SET_CHANNEL, async (_event, range: unknown) => {
    if (!isDashboardRange(range)) throw new Error('unknown dashboard range');
    return saveDashboardRange(range);
  });
}

export function unregisterAutostartIpc(): void {
  ipcMain.removeHandler(AUTOSTART_GET_CHANNEL);
  ipcMain.removeHandler(AUTOSTART_SET_CHANNEL);
  ipcMain.removeHandler(AUTOSTART_GET_HIDDEN_CHANNEL);
  ipcMain.removeHandler(AUTOSTART_SET_HIDDEN_CHANNEL);
  ipcMain.removeHandler(DASHBOARD_RANGE_GET_CHANNEL);
  ipcMain.removeHandler(DASHBOARD_RANGE_SET_CHANNEL);
}

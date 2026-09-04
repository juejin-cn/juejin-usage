import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTO_UPDATE_ACK_COMPLETED_CHANNEL,
  AUTO_UPDATE_CHECK_CHANNEL,
  AUTO_UPDATE_GET_STATE_CHANNEL,
  AUTO_UPDATE_INSTALL_CHANNEL,
  AUTO_UPDATE_SKIP_CHANNEL,
  AUTO_UPDATE_START_CHANNEL,
  AUTO_UPDATE_STATE_CHANGED_CHANNEL,
  createDownloadedUpdateState,
  createSkippedUpdateState,
  isSkippedUpdateVersion,
  type AutoUpdateState,
} from '../shared/auto-update';

const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INSTALL_EXIT_TIMEOUT_MS = 30_000;
const UPDATE_MARKER_FILENAME = 'auto-update.json';
const UPDATE_PREFERENCES_FILENAME = 'auto-update-preferences.json';

const UPDATE_FEED_URL =
  'https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/';

let state: AutoUpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
};
let periodicTimer: NodeJS.Timeout | null = null;
let initialized = false;
let installing = false;
let downloadedVersion: string | undefined;
let skippedVersion: string | undefined;
let installExitTimer: NodeJS.Timeout | null = null;
let beforeInstall: (() => Promise<void>) | null = null;
let onInstallFailed: (() => Promise<void>) | null = null;

type PendingUpdateMarker = {
  pendingVersion: string;
};

type AutoUpdatePreferences = {
  skippedVersion?: string;
};

function updateMarkerPath(): string {
  return join(app.getPath('userData'), UPDATE_MARKER_FILENAME);
}

function updatePreferencesPath(): string {
  return join(app.getPath('userData'), UPDATE_PREFERENCES_FILENAME);
}

async function clearUpdateMarker(): Promise<void> {
  try {
    await unlink(updateMarkerPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeUpdateMarker(version: string): Promise<void> {
  const marker: PendingUpdateMarker = { pendingVersion: version };
  await writeFile(updateMarkerPath(), `${JSON.stringify(marker)}\n`, 'utf8');
}

async function readSkippedVersion(): Promise<string | undefined> {
  try {
    const raw = await readFile(updatePreferencesPath(), 'utf8');
    const preferences = JSON.parse(raw) as Partial<AutoUpdatePreferences>;
    if (typeof preferences.skippedVersion !== 'string') return undefined;
    return preferences.skippedVersion.trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        '[jusage-desktop] failed to read update preferences:',
        error instanceof Error ? error.message : error,
      );
    }
    return undefined;
  }
}

async function persistSkippedVersion(version: string | undefined): Promise<void> {
  if (!version) {
    try {
      await unlink(updatePreferencesPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
  const preferences: AutoUpdatePreferences = { skippedVersion: version };
  await writeFile(
    updatePreferencesPath(),
    `${JSON.stringify(preferences)}\n`,
    'utf8',
  );
}

async function readCompletedVersion(): Promise<string | undefined> {
  try {
    const raw = await readFile(updateMarkerPath(), 'utf8');
    const marker = JSON.parse(raw) as Partial<PendingUpdateMarker>;
    if (
      typeof marker.pendingVersion === 'string' &&
      marker.pendingVersion === app.getVersion()
    ) {
      return marker.pendingVersion;
    }
    await clearUpdateMarker();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        '[jusage-desktop] failed to read update marker:',
        error instanceof Error ? error.message : error,
      );
      await clearUpdateMarker().catch(() => {});
    }
  }
  return undefined;
}

function broadcastState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(AUTO_UPDATE_STATE_CHANGED_CHANNEL, state);
    }
  }
}

function setState(next: AutoUpdateState): void {
  state = {
    ...next,
    ...(state.completedVersion
      ? { completedVersion: state.completedVersion }
      : {}),
  };
  broadcastState();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '检查更新失败，请稍后重试';
}

function installErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '自动安装更新失败，请稍后重试';
}

function downloadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '下载更新失败，请稍后重试';
}

function clearInstallExitTimer(): void {
  if (installExitTimer) clearTimeout(installExitTimer);
  installExitTimer = null;
}

async function checkForUpdates(
  reconsiderSkippedVersion = false,
): Promise<AutoUpdateState> {
  if (!app.isPackaged) return state;
  if (
    state.status === 'checking' ||
    state.status === 'downloading' ||
    state.status === 'downloaded' ||
    state.status === 'installing'
  ) {
    return state;
  }

  if (reconsiderSkippedVersion && skippedVersion) {
    await persistSkippedVersion(undefined);
    skippedVersion = undefined;
  }

  setState({
    status: 'checking',
    currentVersion: app.getVersion(),
  });
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // electron-updater emits `error` before rejecting. The event handler owns
    // the user-facing state; swallowing here avoids an unhandled rejection.
  }
  return state;
}

async function downloadAndInstallAvailableUpdate(): Promise<AutoUpdateState> {
  const version = state.version;
  if (!version || state.status !== 'available') return state;

  setState({
    status: 'downloading',
    currentVersion: app.getVersion(),
    version,
    percent: 0,
    checkedAt: state.checkedAt,
  });
  try {
    await autoUpdater.downloadUpdate();
    if (downloadedVersion === version) {
      return installDownloadedUpdate();
    }
  } catch (error) {
    setState({
      status: 'error',
      currentVersion: app.getVersion(),
      version,
      message: downloadErrorMessage(error),
      checkedAt: state.checkedAt,
    });
  }
  return state;
}

async function skipUpdate(): Promise<AutoUpdateState> {
  const version = state.version ?? downloadedVersion;
  if (
    !version ||
    (state.status !== 'available' && state.status !== 'downloaded')
  ) {
    return state;
  }

  await persistSkippedVersion(version);
  skippedVersion = version;
  downloadedVersion = undefined;
  setState(
    createSkippedUpdateState(app.getVersion(), version, state.checkedAt),
  );
  return state;
}

async function recoverInstallAttempt(message: string): Promise<void> {
  if (!installing) return;
  installing = false;
  clearInstallExitTimer();
  await clearUpdateMarker().catch(() => {});
  await recoverFromInstallFailure();
  if (!downloadedVersion) {
    setState({
      status: 'error',
      currentVersion: app.getVersion(),
      message,
      checkedAt: state.checkedAt,
    });
    return;
  }
  setState(
    createDownloadedUpdateState(
      app.getVersion(),
      downloadedVersion,
      state.checkedAt,
      message,
    ),
  );
}

async function installDownloadedUpdate(): Promise<AutoUpdateState> {
  const version = downloadedVersion ?? state.version;
  if (!version || installing) return state;
  downloadedVersion = version;
  installing = true;
  setState({
    status: 'installing',
    currentVersion: app.getVersion(),
    version,
    percent: 100,
    checkedAt: state.checkedAt,
  });
  try {
    // Arm the watchdog before beforeInstall: stopLocalRuntime can hang, and
    // quitAndInstall has no success ack. If the process is still here later,
    // recover runtime and let the user retry.
    installExitTimer = setTimeout(() => {
      void recoverInstallAttempt(
        '自动重启未完成，请点击“重启并更新”再次尝试。',
      );
    }, INSTALL_EXIT_TIMEOUT_MS);
    installExitTimer.unref();
    await writeUpdateMarker(version);
    await beforeInstall?.();
    if (!installing) return state;
    autoUpdater.quitAndInstall(false, true);
  } catch (error) {
    const message = installErrorMessage(error);
    await recoverInstallAttempt(message);
  }
  return state;
}

async function recoverFromInstallFailure(): Promise<void> {
  try {
    await onInstallFailed?.();
  } catch (error) {
    console.error(
      '[jusage-desktop] failed to recover after update install error:',
      error instanceof Error ? error.message : error,
    );
  }
}

async function acknowledgeCompletedUpdate(): Promise<void> {
  await clearUpdateMarker();
  if (!state.completedVersion) return;
  const { completedVersion: _completedVersion, ...next } = state;
  state = next;
  broadcastState();
}

function registerIpc(): void {
  ipcMain.removeHandler(AUTO_UPDATE_GET_STATE_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_CHECK_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_START_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_SKIP_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_ACK_COMPLETED_CHANNEL);
  ipcMain.handle(AUTO_UPDATE_GET_STATE_CHANNEL, () => state);
  ipcMain.handle(AUTO_UPDATE_CHECK_CHANNEL, () => checkForUpdates(true));
  ipcMain.handle(AUTO_UPDATE_START_CHANNEL, () =>
    downloadAndInstallAvailableUpdate(),
  );
  ipcMain.handle(AUTO_UPDATE_SKIP_CHANNEL, () => skipUpdate());
  ipcMain.handle(AUTO_UPDATE_INSTALL_CHANNEL, () => installDownloadedUpdate());
  ipcMain.handle(AUTO_UPDATE_ACK_COMPLETED_CHANNEL, () =>
    acknowledgeCompletedUpdate(),
  );
}

export async function initializeAutoUpdate(options: {
  beforeInstall: () => Promise<void>;
  onInstallFailed: () => Promise<void>;
}): Promise<void> {
  if (initialized) return;
  initialized = true;
  installing = false;
  downloadedVersion = undefined;
  skippedVersion = app.isPackaged ? await readSkippedVersion() : undefined;
  clearInstallExitTimer();
  beforeInstall = options.beforeInstall;
  onInstallFailed = options.onInstallFailed;
  const completedVersion = app.isPackaged
    ? await readCompletedVersion()
    : undefined;
  state = {
    status: app.isPackaged ? 'idle' : 'unsupported',
    currentVersion: app.getVersion(),
    ...(completedVersion ? { completedVersion } : {}),
    ...(!app.isPackaged
      ? { message: '开发环境不检查更新，请安装正式构建包后测试' }
      : {}),
  };
  registerIpc();

  if (!app.isPackaged) return;

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED_URL,
  });
  autoUpdater.channel = app.getVersion().includes('-') ? 'beta' : 'latest';
  // channel setter forces allowDowngrade=true; turn it back off so a
  // mis-published older yml cannot overwrite a newer install.
  autoUpdater.allowDowngrade = false;
  // Detection remains automatic. A single explicit user choice authorizes the
  // download and the following restart, so discovery cannot stop the runtime.
  autoUpdater.autoDownload = false;
  // We install explicitly after releasing the local runtime owner.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = app.getVersion().includes('-');

  autoUpdater.on('checking-for-update', () => {
    setState({
      status: 'checking',
      currentVersion: app.getVersion(),
    });
  });
  autoUpdater.on('update-available', (info) => {
    const checkedAt = new Date().toISOString();
    if (isSkippedUpdateVersion(info.version, skippedVersion)) {
      setState(
        createSkippedUpdateState(app.getVersion(), info.version, checkedAt),
      );
      return;
    }
    setState({
      status: 'available',
      currentVersion: app.getVersion(),
      version: info.version,
      checkedAt,
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    setState({
      status: 'not-available',
      currentVersion: app.getVersion(),
      version: info.version,
      checkedAt: new Date().toISOString(),
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      currentVersion: app.getVersion(),
      version: state.version,
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      checkedAt: state.checkedAt,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    setState(
      createDownloadedUpdateState(
        app.getVersion(),
        info.version,
        state.checkedAt,
      ),
    );
  });
  autoUpdater.on('error', (error) => {
    if (installing) {
      void recoverInstallAttempt(installErrorMessage(error));
      return;
    }
    setState({
      status: 'error',
      currentVersion: app.getVersion(),
      version: state.version,
      message: errorMessage(error),
      checkedAt: new Date().toISOString(),
    });
  });

  void checkForUpdates();
  periodicTimer = setInterval(() => {
    void checkForUpdates();
  }, PERIODIC_CHECK_INTERVAL_MS);
  periodicTimer.unref();
}

export function disposeAutoUpdate(): void {
  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = null;
  ipcMain.removeHandler(AUTO_UPDATE_GET_STATE_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_CHECK_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_START_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_SKIP_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_ACK_COMPLETED_CHANNEL);
  autoUpdater.removeAllListeners();
  clearInstallExitTimer();
  installing = false;
  downloadedVersion = undefined;
  skippedVersion = undefined;
  beforeInstall = null;
  onInstallFailed = null;
  initialized = false;
}

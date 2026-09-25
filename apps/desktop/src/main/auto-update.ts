import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTO_UPDATE_ACK_COMPLETED_CHANNEL,
  AUTO_UPDATE_CHECK_CHANNEL,
  AUTO_UPDATE_GET_STATE_CHANNEL,
  AUTO_UPDATE_INSTALL_CHANNEL,
  AUTO_UPDATE_STATE_CHANGED_CHANNEL,
  createDownloadedUpdateState,
  type AutoUpdateState,
} from '../shared/auto-update.js';

const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INSTALL_EXIT_TIMEOUT_MS = 30_000;
const UPDATE_MARKER_FILENAME = 'auto-update.json';

const UPDATE_FEED_URL =
  'https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/';
const PORTABLE_UPDATE_MESSAGE =
  '点击前往 Gitee Release 下载便携版';

let state: AutoUpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
};
let periodicTimer: NodeJS.Timeout | null = null;
let initialized = false;
type InstallAttempt = { recovering: boolean };
let installAttempt: InstallAttempt | null = null;
let downloadedVersion: string | undefined;
let installExitTimer: NodeJS.Timeout | null = null;
let beforeInstall: (() => Promise<void>) | null = null;
let onInstallFailed: (() => Promise<void>) | null = null;

type PendingUpdateMarker = {
  pendingVersion: string;
};

function updateMarkerPath(): string {
  return join(app.getPath('userData'), UPDATE_MARKER_FILENAME);
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

function clearInstallExitTimer(): void {
  if (installExitTimer) clearTimeout(installExitTimer);
  installExitTimer = null;
}

async function checkForUpdates(): Promise<AutoUpdateState> {
  if (!app.isPackaged) return state;
  if (
    state.status === 'checking' ||
    state.status === 'downloading' ||
    state.status === 'downloaded' ||
    state.status === 'installing'
  ) {
    return state;
  }

  setState({
    status: 'checking',
    currentVersion: app.getVersion(),
  });
  try {
    const result = await autoUpdater.checkForUpdates();
    // Automatic downloads have a separate promise. Errors are displayed by
    // the updater event handler, but the rejection still needs a consumer.
    void result?.downloadPromise?.catch(() => {});
  } catch {
    // electron-updater emits `error` before rejecting. The event handler owns
    // the user-facing state; swallowing here avoids an unhandled rejection.
  }
  return state;
}

async function recoverInstallAttempt(
  attempt: InstallAttempt,
  message: string,
): Promise<void> {
  if (installAttempt !== attempt || attempt.recovering) return;
  attempt.recovering = true;
  clearInstallExitTimer();
  await clearUpdateMarker().catch(() => {});
  if (installAttempt !== attempt) return;
  await recoverFromInstallFailure();
  if (installAttempt !== attempt) return;
  // electron-updater 6.x BaseUpdater (Windows/Linux) retains this latch if
  // install launched but app.quit was cancelled. Without resetting it the
  // first manual quitAndInstall only clears the latch and does no installation.
  if ('quitAndInstallCalled' in autoUpdater) {
    autoUpdater.quitAndInstallCalled = false;
  }
  installAttempt = null;
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

function installDownloadedUpdate(): AutoUpdateState {
  const version = downloadedVersion;
  if (!version || installAttempt || state.status !== 'downloaded') return state;
  const attempt: InstallAttempt = { recovering: false };
  installAttempt = attempt;
  setState({
    status: 'installing',
    currentVersion: app.getVersion(),
    version,
    percent: 100,
    checkedAt: state.checkedAt,
  });
  // Acknowledge IPC immediately: a hung preparation must not keep the renderer
  // request pending after the watchdog has made the update retryable again.
  void runInstallAttempt(attempt, version);
  return state;
}

async function runInstallAttempt(attempt: InstallAttempt, version: string): Promise<void> {
  try {
    // Arm the watchdog before beforeInstall: stopLocalRuntime can hang, and
    // quitAndInstall has no success ack. If the process is still here later,
    // recover runtime and let the user retry.
    installExitTimer = setTimeout(() => {
      void recoverInstallAttempt(
        attempt,
        '自动重启未完成，请点击“更新并重启”再次尝试。',
      );
    }, INSTALL_EXIT_TIMEOUT_MS);
    installExitTimer.unref();
    await writeUpdateMarker(version);
    if (installAttempt !== attempt || attempt.recovering) return;
    await beforeInstall?.();
    // A late completion from a timed-out attempt cannot install on behalf of
    // a newer retry or interrupt the runtime restored by recovery.
    if (installAttempt !== attempt || attempt.recovering) return;
    autoUpdater.quitAndInstall(false, true);
  } catch (error) {
    const message = installErrorMessage(error);
    await recoverInstallAttempt(attempt, message);
  }
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
  ipcMain.removeHandler(AUTO_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_ACK_COMPLETED_CHANNEL);
  ipcMain.handle(AUTO_UPDATE_GET_STATE_CHANNEL, () => state);
  ipcMain.handle(AUTO_UPDATE_CHECK_CHANNEL, () => checkForUpdates());
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
  installAttempt = null;
  downloadedVersion = undefined;
  clearInstallExitTimer();
  beforeInstall = options.beforeInstall;
  onInstallFailed = options.onInstallFailed;
  const isPortableExecutable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  const automaticInstallationSupported = app.isPackaged && !isPortableExecutable;
  const completedVersion = automaticInstallationSupported
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
  // Portable builds can use the shared feed to announce a newer version, but
  // downloading that feed's NSIS package would convert them into an install.
  autoUpdater.autoDownload = !isPortableExecutable;
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
    setState({
      status: isPortableExecutable ? 'available' : 'downloading',
      currentVersion: app.getVersion(),
      version: info.version,
      checkedAt,
      ...(isPortableExecutable ? { message: PORTABLE_UPDATE_MESSAGE } : {}),
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
    if (isPortableExecutable) return;
    if (installAttempt || downloadedVersion === info.version) return;
    downloadedVersion = info.version;
    setState(
      createDownloadedUpdateState(
        app.getVersion(),
        info.version,
        state.checkedAt,
      ),
    );
    installDownloadedUpdate();
  });
  autoUpdater.on('error', (error) => {
    if (installAttempt) {
      void recoverInstallAttempt(installAttempt, installErrorMessage(error));
      return;
    }
    if (downloadedVersion) {
      setState(createDownloadedUpdateState(
        app.getVersion(), downloadedVersion, state.checkedAt, installErrorMessage(error),
      ));
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
  ipcMain.removeHandler(AUTO_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(AUTO_UPDATE_ACK_COMPLETED_CHANNEL);
  autoUpdater.removeAllListeners();
  clearInstallExitTimer();
  installAttempt = null;
  downloadedVersion = undefined;
  beforeInstall = null;
  onInstallFailed = null;
  initialized = false;
}

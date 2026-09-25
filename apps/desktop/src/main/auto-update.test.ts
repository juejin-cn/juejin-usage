import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import {
  AUTO_UPDATE_ACK_COMPLETED_CHANNEL,
  AUTO_UPDATE_CHECK_CHANNEL,
  AUTO_UPDATE_GET_STATE_CHANNEL,
  AUTO_UPDATE_INSTALL_CHANNEL,
  type AutoUpdateState,
} from '../shared/auto-update.js';

// Exercise the actual main-process module with an Electron boundary double.
// No Electron process, network, user data, or installer is touched by these tests.
let userData: string;
const handlers = new Map<string, () => unknown>();
const app = { isPackaged: true, getVersion: () => '0.1.8', getPath: () => userData };
const updater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  autoRunAppAfterInstall: false,
  allowDowngrade: true,
  channel: '',
  quitAndInstallCalled: false,
  setFeedURL: mock.fn(),
  checkForUpdates: mock.fn(async (): Promise<{
    downloadPromise?: Promise<string[]>;
  } | null> => null),
  quitAndInstall: mock.fn((_silent?: boolean, _forceRun?: boolean) => {}),
});
const sentStates: AutoUpdateState[] = [];
const electronId = require.resolve('electron');
const updaterId = require.resolve('electron-updater');
require(electronId);
require(updaterId);
const originalElectron = require.cache[electronId]!.exports;
const originalUpdater = require.cache[updaterId]!.exports;
require.cache[electronId]!.exports = {
  app,
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, callback: () => unknown) => handlers.set(channel, callback),
  },
  BrowserWindow: { getAllWindows: () => [{
    isDestroyed: () => false,
    webContents: { send: (_channel: string, state: AutoUpdateState) => sentStates.push(state) },
  }] },
};
require.cache[updaterId]!.exports = { autoUpdater: updater };
const { initializeAutoUpdate, disposeAutoUpdate } = require('./auto-update.js') as
  typeof import('./auto-update.js');
require.cache[electronId]!.exports = originalElectron;
require.cache[updaterId]!.exports = originalUpdater;

const getState = () => handlers.get(AUTO_UPDATE_GET_STATE_CHANNEL)!() as AutoUpdateState;
const install = () => handlers.get(AUTO_UPDATE_INSTALL_CHANNEL)!() as AutoUpdateState;
const check = () => handlers.get(AUTO_UPDATE_CHECK_CHANNEL)!() as Promise<AutoUpdateState>;
const downloaded = () => updater.emit('update-downloaded', { version: '0.1.9' });
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'jusage-auto-update-test-'));
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  sentStates.length = 0;
  app.isPackaged = true;
  updater.quitAndInstallCalled = false;
  updater.quitAndInstall = mock.fn(() => {});
  updater.checkForUpdates = mock.fn(async () => {
    updater.emit('checking-for-update');
    updater.emit('update-not-available', { version: '0.1.8' });
    return null;
  });
});
afterEach(async () => {
  disposeAutoUpdate();
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  await rm(userData, { recursive: true, force: true });
});

test('packaged startup enables automatic downloading and only supported IPC', async () => {
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: async () => {} });
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.checkForUpdates.mock.callCount(), 1);
  assert.deepEqual([...handlers.keys()].sort(), [
    AUTO_UPDATE_GET_STATE_CHANNEL, AUTO_UPDATE_CHECK_CHANNEL,
    AUTO_UPDATE_INSTALL_CHANNEL, AUTO_UPDATE_ACK_COMPLETED_CHANNEL,
  ].sort());
  assert.deepEqual(await readdir(userData), []);
  updater.emit('update-available', { version: '0.1.9' });
  assert.equal(getState().status, 'downloading');
  assert.equal(getState().version, '0.1.9');
  assert.equal(getState().percent, undefined);
});

test('development never checks for updates or starts an installation', async () => {
  app.isPackaged = false;
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: async () => {} });
  assert.equal(getState().status, 'unsupported');
  await check();
  install();
  assert.equal(updater.checkForUpdates.mock.callCount(), 0);
  assert.equal(updater.quitAndInstall.mock.callCount(), 0);
});

test('portable build reports new versions without downloading the NSIS package', async () => {
  process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Downloads\\Juejin.Usage.Portable.exe';
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: async () => {} });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.checkForUpdates.mock.callCount(), 1);
  updater.emit('update-available', { version: '0.1.9' });
  assert.equal(getState().status, 'available');
  assert.equal(getState().version, '0.1.9');
  assert.equal(
    getState().message,
    '点击前往 Gitee Release 下载便携版',
  );
  install();
  assert.equal(updater.quitAndInstall.mock.callCount(), 0);
});

test('download completion automatically prepares runtime and installs once', async () => {
  const preparation = deferred();
  const beforeInstall = mock.fn(() => preparation.promise);
  await initializeAutoUpdate({ beforeInstall, onInstallFailed: async () => {} });
  downloaded();
  assert.equal(getState().status, 'installing');
  await until(() => beforeInstall.mock.callCount() === 1);
  install();
  downloaded();
  assert.equal(updater.quitAndInstall.mock.callCount(), 0);
  preparation.resolve();
  await until(() => updater.quitAndInstall.mock.callCount() === 1);
  assert.deepEqual(updater.quitAndInstall.mock.calls[0].arguments, [false, true]);
  assert.deepEqual(JSON.parse(await readFile(join(userData, 'auto-update.json'), 'utf8')), {
    pendingVersion: '0.1.9',
  });
});

test('install IPC refuses an update that has not finished downloading', async () => {
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: async () => {} });
  updater.emit('update-available', { version: '0.1.9' });
  assert.equal(install().status, 'downloading');
  assert.equal(updater.quitAndInstall.mock.callCount(), 0);
});

test('preparation errors recover runtime and a single manual request retries', async () => {
  const beforeInstall = mock.fn(async () => {
    if (beforeInstall.mock.callCount() === 0) throw new Error('stop failed');
  });
  const recover = mock.fn(async () => {});
  await initializeAutoUpdate({ beforeInstall, onInstallFailed: recover });
  downloaded();
  await until(() => getState().status === 'downloaded');
  assert.equal(getState().message, 'stop failed');
  assert.equal(recover.mock.callCount(), 1);
  assert.deepEqual(await readdir(userData), []);
  assert.equal(install().status, 'installing');
  await until(() => updater.quitAndInstall.mock.callCount() === 1);
  assert.equal(beforeInstall.mock.callCount(), 2);
});

test('installer errors recover once and retain the downloaded retry action', async () => {
  const recover = mock.fn(async () => {});
  updater.quitAndInstall = mock.fn(() => {
    if (updater.quitAndInstall.mock.callCount() === 0) {
      updater.emit('error', new Error('native install failed'));
      throw new Error('same failure rejected');
    }
  });
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: recover });
  downloaded();
  await until(() => getState().status === 'downloaded');
  assert.equal(recover.mock.callCount(), 1);
  assert.equal(getState().message, 'native install failed');
  updater.emit('error', new Error('late native error'));
  assert.equal(getState().status, 'downloaded');
  install();
  await until(() => updater.quitAndInstall.mock.callCount() === 2);
});

test('exit timeout clears the BaseUpdater latch before the first manual retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let launches = 0;
  updater.quitAndInstall = mock.fn(() => {
    if (updater.quitAndInstallCalled) { updater.quitAndInstallCalled = false; return; }
    updater.quitAndInstallCalled = true;
    launches++;
  });
  const recover = mock.fn(async () => {});
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: recover });
  downloaded();
  await until(() => launches === 1);
  t.mock.timers.tick(30_000);
  await until(() => getState().status === 'downloaded');
  assert.equal(recover.mock.callCount(), 1);
  assert.equal(updater.quitAndInstallCalled, false);
  install();
  await until(() => launches === 2);
});

test('hung preparation cannot keep IPC pending or hijack a newer attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const first = deferred();
  const second = deferred();
  const beforeInstall = mock.fn(() => beforeInstall.mock.callCount() === 0 ? first.promise : second.promise);
  await initializeAutoUpdate({ beforeInstall, onInstallFailed: async () => {} });
  downloaded();
  await until(() => beforeInstall.mock.callCount() === 1);
  t.mock.timers.tick(30_000);
  await until(() => getState().status === 'downloaded');
  const response = install();
  assert.equal(response.status, 'installing');
  assert.equal(response instanceof Promise, false);
  await until(() => beforeInstall.mock.callCount() === 2);
  first.resolve();
  await first.promise;
  assert.equal(updater.quitAndInstall.mock.callCount(), 0);
  second.resolve();
  await until(() => updater.quitAndInstall.mock.callCount() === 1);
});

test('recovery is serialized with retry and late duplicate errors', async () => {
  const recovery = deferred();
  const recover = mock.fn(() => recovery.promise);
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: recover });
  downloaded();
  await until(() => updater.quitAndInstall.mock.callCount() === 1);
  updater.emit('error', new Error('first failure'));
  await until(() => recover.mock.callCount() === 1);
  install();
  updater.emit('error', new Error('duplicate failure'));
  assert.equal(getState().status, 'installing');
  assert.equal(recover.mock.callCount(), 1);
  recovery.resolve();
  await until(() => getState().status === 'downloaded');
  install();
  await until(() => updater.quitAndInstall.mock.callCount() === 2);
});

test('failed runtime recovery still leaves installation retryable', async () => {
  await initializeAutoUpdate({
    beforeInstall: async () => { throw new Error('stop failed'); },
    onInstallFailed: async () => { throw new Error('runtime startup failed'); },
  });
  downloaded();
  await until(() => getState().status === 'downloaded');
  assert.equal(getState().version, '0.1.9');
});

test('automatic download rejections are consumed and a check can retry', async () => {
  updater.checkForUpdates = mock.fn(async () => {
    updater.emit('update-available', { version: '0.1.9' });
    return { downloadPromise: Promise.resolve().then(() => {
      const error = new Error('download failed');
      updater.emit('error', error);
      throw error;
    }) };
  });
  await initializeAutoUpdate({ beforeInstall: async () => {}, onInstallFailed: async () => {} });
  await until(() => getState().status === 'error');
  assert.equal(getState().message, 'download failed');
  await check();
  assert.equal(updater.checkForUpdates.mock.callCount(), 2);
});

test('disposal invalidates an unfinished preparation', async () => {
  const preparation = deferred();
  const beforeInstall = mock.fn(() => preparation.promise);
  await initializeAutoUpdate({ beforeInstall, onInstallFailed: async () => {} });
  downloaded();
  await until(() => beforeInstall.mock.callCount() === 1);
  disposeAutoUpdate();
  preparation.resolve();
  await preparation.promise;
  assert.equal(updater.quitAndInstall.mock.callCount(), 0);
  assert.equal(handlers.size, 0);
});

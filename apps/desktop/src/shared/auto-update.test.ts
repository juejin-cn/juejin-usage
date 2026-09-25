/** 验证自动下载进度与安装重试状态。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLatestUpdateVersion,
  createDownloadedUpdateState,
  isUpdateDownloadInProgress,
  shouldOfferUpdateRestart,
  updateDownloadPercent,
  updateStatusMessage,
  getUpdateToolbarAction,
  type AutoUpdateStatus,
} from './auto-update.js';

test('createDownloadedUpdateState keeps the downloaded package retryable', () => {
  assert.deepEqual(
    createDownloadedUpdateState(
      '0.1.7',
      '0.1.8',
      '2026-09-02T00:00:00.000Z',
      '自动重启未完成',
    ),
    {
      status: 'downloaded',
      currentVersion: '0.1.7',
      version: '0.1.8',
      percent: 100,
      checkedAt: '2026-09-02T00:00:00.000Z',
      message: '自动重启未完成',
    },
  );
});

test('createDownloadedUpdateState omits an empty failure message', () => {
  assert.equal(
    'message' in createDownloadedUpdateState('0.1.7', '0.1.8'),
    false,
  );
});

test('shouldOfferUpdateRestart covers downloaded and in-flight install', () => {
  assert.equal(shouldOfferUpdateRestart('downloaded'), true);
  assert.equal(shouldOfferUpdateRestart('installing'), true);
  assert.equal(shouldOfferUpdateRestart('idle'), false);
  assert.equal(shouldOfferUpdateRestart('checking'), false);
});

test('isUpdateDownloadInProgress only covers an active download', () => {
  assert.equal(isUpdateDownloadInProgress('checking'), false);
  assert.equal(isUpdateDownloadInProgress('downloading'), true);
  assert.equal(isUpdateDownloadInProgress('downloaded'), false);
  assert.equal(isUpdateDownloadInProgress('installing'), false);
});

test('updateDownloadPercent clamps to 0-100', () => {
  assert.equal(updateDownloadPercent(undefined), 0);
  assert.equal(updateDownloadPercent(36.6), 37);
  assert.equal(updateDownloadPercent(-4), 0);
  assert.equal(updateDownloadPercent(140), 100);
});

test('settings are silent when no newer version is available', () => {
  for (const version of [undefined, '0.1.8', '0.1.7']) {
    assert.equal(updateStatusMessage({
      status: 'not-available',
      currentVersion: '0.1.8',
      version,
    }), '');
    assert.equal(getLatestUpdateVersion({
      status: 'not-available',
      currentVersion: '0.1.8',
      version,
    }), null);
  }
});

test('settings retain the aligned latest version throughout download and install', () => {
  for (const status of ['available', 'downloading', 'downloaded', 'installing'] as const) {
    assert.equal(getLatestUpdateVersion({
      status,
      currentVersion: '0.1.8',
      version: '0.1.9',
    }), '0.1.9');
  }
});

test('settings do not invent a latest version when it is missing', () => {
  assert.equal(getLatestUpdateVersion(null), null);
  assert.equal(getLatestUpdateVersion({
    status: 'downloading',
    currentVersion: '0.1.8',
  }), null);
});

test('settings leave download and restart progress to the shared action button', () => {
  for (const status of ['downloading', 'downloaded', 'installing'] as const) {
    const state = { status, currentVersion: '0.1.8', version: '0.1.9' };
    assert.equal(updateStatusMessage(state), '');
    assert.notEqual(getUpdateToolbarAction(state), null);
  }
  assert.equal(updateStatusMessage(createDownloadedUpdateState(
    '0.1.8', '0.1.9', undefined, 'Restart timed out',
  )), '');
});

test('settings retain error messages', () => {
  assert.equal(updateStatusMessage({
    status: 'error',
    currentVersion: '0.1.8',
  }), '未能完成更新，可稍后重试');
});

test('toolbar progress and installation states cannot start another action', () => {
  assert.deepEqual(getUpdateToolbarAction({ status: 'downloading', currentVersion: '0.1.8', percent: 36.6 }), {
    label: '下载 37%', request: null,
  });
  assert.deepEqual(getUpdateToolbarAction({ status: 'downloading', currentVersion: '0.1.8' }), {
    label: '正在下载…', request: null,
  });
  assert.deepEqual(getUpdateToolbarAction({ status: 'installing', currentVersion: '0.1.8' }), {
    label: '正在重启…', request: null,
  });
});

test('toolbar retains restart, check retries, and portable release download', () => {
  assert.deepEqual(getUpdateToolbarAction({
    status: 'available',
    currentVersion: '0.1.8',
    version: '0.1.9',
  }), {
    label: '发现新版本', request: 'open-releases',
  });
  assert.deepEqual(getUpdateToolbarAction(createDownloadedUpdateState('0.1.8', '0.1.9', undefined, 'Restart timed out')), {
    label: '更新并重启', request: 'install',
  });
  assert.deepEqual(getUpdateToolbarAction({ status: 'error', currentVersion: '0.1.8' }), {
    label: '重试更新', request: 'check',
  });
});

test('toolbar stays hidden when no update action is needed', () => {
  assert.equal(getUpdateToolbarAction(null), null);
  for (const status of ['idle', 'checking', 'unsupported', 'not-available'] satisfies AutoUpdateStatus[]) {
    assert.equal(getUpdateToolbarAction({ status, currentVersion: '0.1.8' }), null);
  }
});

/** 验证更新选择、下载进度与安装重试状态。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDownloadedUpdateState,
  createSkippedUpdateState,
  isUpdateDownloadInProgress,
  isSkippedUpdateVersion,
  shouldOfferUpdateDownload,
  shouldOfferUpdateRestart,
  updateDownloadPercent,
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
  assert.equal(isUpdateDownloadInProgress('available'), false);
  assert.equal(isUpdateDownloadInProgress('downloading'), true);
  assert.equal(isUpdateDownloadInProgress('downloaded'), false);
  assert.equal(isUpdateDownloadInProgress('installing'), false);
});

test('only available updates offer the download action', () => {
  assert.equal(shouldOfferUpdateDownload('available'), true);
  assert.equal(shouldOfferUpdateDownload('downloading'), false);
  assert.equal(shouldOfferUpdateDownload('downloaded'), false);
  assert.equal(shouldOfferUpdateDownload('installing'), false);
});

test('createSkippedUpdateState keeps the ignored version visible', () => {
  assert.deepEqual(
    createSkippedUpdateState(
      '0.1.8',
      '0.1.9',
      '2026-09-04T00:00:00.000Z',
    ),
    {
      status: 'skipped',
      currentVersion: '0.1.8',
      version: '0.1.9',
      checkedAt: '2026-09-04T00:00:00.000Z',
    },
  );
});

test('isSkippedUpdateVersion only matches the persisted version', () => {
  assert.equal(isSkippedUpdateVersion('0.1.9', '0.1.9'), true);
  assert.equal(isSkippedUpdateVersion('0.2.0', '0.1.9'), false);
  assert.equal(isSkippedUpdateVersion('0.1.9', undefined), false);
});

test('updateDownloadPercent clamps to 0-100', () => {
  assert.equal(updateDownloadPercent(undefined), 0);
  assert.equal(updateDownloadPercent(36.6), 37);
  assert.equal(updateDownloadPercent(-4), 0);
  assert.equal(updateDownloadPercent(140), 100);
});

test('toolbar offers a direct download action for available updates', () => {
  assert.deepEqual(getUpdateToolbarAction({ status: 'available', currentVersion: '0.1.8', version: '0.1.9' }), {
    label: '下载并更新', request: 'download',
  });
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

test('toolbar retains restart and check retries without opening a dialog', () => {
  assert.deepEqual(getUpdateToolbarAction(createDownloadedUpdateState('0.1.8', '0.1.9', undefined, 'Restart timed out')), {
    label: '重启并更新', request: 'install',
  });
  assert.deepEqual(getUpdateToolbarAction({ status: 'error', currentVersion: '0.1.8' }), {
    label: '重试更新', request: 'check',
  });
});

test('toolbar stays hidden when no update action is needed', () => {
  assert.equal(getUpdateToolbarAction(null), null);
  for (const status of ['idle', 'checking', 'unsupported', 'skipped', 'not-available'] satisfies AutoUpdateStatus[]) {
    assert.equal(getUpdateToolbarAction({ status, currentVersion: '0.1.8' }), null);
  }
});

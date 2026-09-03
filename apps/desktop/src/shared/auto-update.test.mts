/** 验证自动重启失败后仍可手动安装的更新状态。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDownloadedUpdateState,
  isUpdateDownloadInProgress,
  shouldOfferUpdateRestart,
  updateDownloadPercent,
} from './auto-update.ts';

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

test('isUpdateDownloadInProgress covers available and downloading', () => {
  assert.equal(isUpdateDownloadInProgress('available'), true);
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

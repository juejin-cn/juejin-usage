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
  shouldOfferUpdateSkip,
  updateDownloadPercent,
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

test('available updates offer download and skip actions', () => {
  assert.equal(shouldOfferUpdateDownload('available'), true);
  assert.equal(shouldOfferUpdateDownload('downloading'), false);
  assert.equal(shouldOfferUpdateSkip('available'), true);
  assert.equal(shouldOfferUpdateSkip('downloaded'), true);
  assert.equal(shouldOfferUpdateSkip('downloading'), false);
  assert.equal(shouldOfferUpdateSkip('installing'), false);
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

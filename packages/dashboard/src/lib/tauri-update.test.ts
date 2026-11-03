import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getUpdateToolbarAction } from '../../../../apps/desktop/src/shared/auto-update.ts';
import type { TauriUpdateSnapshot } from './tauri-desktop.ts';
import { getTauriUpdateToolbarAction } from './tauri-update.ts';

function snapshot(status: TauriUpdateSnapshot['status'], extra: Partial<TauriUpdateSnapshot> = {}): TauriUpdateSnapshot {
  return { status, currentVersion: '2.0.0-next.3', availableVersion: '2.0.0-next.4', message: null, ...extra };
}

test('Tauri toolbar matches Electron for download, restart and retry actions', () => {
  for (const status of ['downloading', 'downloaded', 'installing', 'error'] as const) {
    assert.deepEqual(
      getTauriUpdateToolbarAction(snapshot(status, {downloadedBytes: 45, totalBytes: 100})),
      getUpdateToolbarAction({status, currentVersion: '2.0.0-next.3', version: '2.0.0-next.4', percent: 45}),
    );
  }
});

test('errors recheck even if an available version remains after a failed installation', () => {
  for (const availableVersion of ['2.0.0-next.4', null]) {
    assert.deepEqual(getTauriUpdateToolbarAction(snapshot('error', {availableVersion})), {
      label: '重试更新', request: 'check',
    });
  }
});

test('download progress handles unknown totals, zero, rounding and out-of-range bytes', () => {
  for (const totalBytes of [undefined, null, 0, NaN, Infinity, -1]) {
    assert.deepEqual(getTauriUpdateToolbarAction(snapshot('downloading', {totalBytes, downloadedBytes: 10})), {
      label: '正在下载…', request: null,
    });
  }
  for (const [downloadedBytes, label] of [[0, '下载 0%'], [44.6, '下载 45%'], [110, '下载 100%'], [-2, '下载 0%']] as const) {
    assert.equal(getTauriUpdateToolbarAction(snapshot('downloading', {totalBytes: 100, downloadedBytes}))?.label, label);
  }
});

test('quiet states do not add toolbar chrome; an available Tauri update uses the native check flow', () => {
  assert.equal(getTauriUpdateToolbarAction(null), null);
  for (const status of ['disabled', 'idle', 'checking', 'notAvailable'] as const) {
    assert.equal(getTauriUpdateToolbarAction(snapshot(status)), null);
  }
  assert.equal(getTauriUpdateToolbarAction(snapshot('available'))?.label,
    getUpdateToolbarAction({status: 'available', currentVersion: '2.0.0-next.3'})?.label);
  assert.equal(getTauriUpdateToolbarAction(snapshot('available'))?.request, 'check');
});

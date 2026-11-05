import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TauriRuntimeSnapshot, TauriUpdateSnapshot } from './tauri-desktop.ts';
import { shouldShowTauriRuntimeRecovery } from './tauri-runtime.ts';

const update = (status: TauriUpdateSnapshot['status']): TauriUpdateSnapshot => ({
  status, currentVersion: '2.0.0-next.4', availableVersion: '2.0.0-next.5', message: null,
});
const runtime = (phase: TauriRuntimeSnapshot['phase'], reason: string | null = null): TauriRuntimeSnapshot => ({
  phase, attempt: 0, reason,
});

test('update restart does not flash a recovery banner when the sidecar stops', () => {
  for (const [phase, status] of [
    ['ready', 'downloaded'], ['ready', 'installing'], ['stopped', 'installing'],
  ] as const) {
    assert.equal(shouldShowTauriRuntimeRecovery(runtime(phase), update(status)), false);
  }
  // A newly mounted window can also read a stopped runtime during installation.
  assert.equal(shouldShowTauriRuntimeRecovery(runtime('stopped'), null), false);
  assert.equal(shouldShowTauriRuntimeRecovery(runtime('failed'), update('installing')), false);
});

test('installation failure restores recovery UI until the sidecar is ready again', () => {
  assert.equal(shouldShowTauriRuntimeRecovery(runtime('stopped'), update('error')), true);
  assert.equal(shouldShowTauriRuntimeRecovery(runtime('failed'), update('error')), true);
  assert.equal(shouldShowTauriRuntimeRecovery(runtime('ready'), update('error')), false);
});

test('runtime crashes and ownership failures remain visible outside installation', () => {
  for (const status of [update('disabled'), update('idle'), update('downloading'), update('downloaded')]) {
    assert.equal(shouldShowTauriRuntimeRecovery(runtime('failed', 'ownership'), status), true);
    assert.equal(shouldShowTauriRuntimeRecovery(runtime('stopped'), status), true);
    assert.equal(shouldShowTauriRuntimeRecovery(runtime('recovering'), status), false);
    assert.equal(shouldShowTauriRuntimeRecovery(null, status), false);
  }
});

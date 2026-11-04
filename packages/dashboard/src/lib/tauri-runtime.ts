import type { TauriRuntimeSnapshot, TauriUpdateSnapshot } from './tauri-desktop';

/** Installing an update deliberately stops the sidecar before replacing the app. */
export function shouldShowTauriRuntimeRecovery(
  runtime: TauriRuntimeSnapshot | null,
  update: TauriUpdateSnapshot | null,
): boolean {
  // Wait for the update snapshot too: the runtime snapshot may arrive first
  // when a window mounts while the installer is already stopping the sidecar.
  return update !== null && update.status !== 'installing'
    && (runtime?.phase === 'failed' || runtime?.phase === 'stopped');
}

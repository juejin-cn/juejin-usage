import { useEffect, useRef, useState } from 'react';
import {
  getUpdateToolbarAction,
  type AutoUpdateState,
} from '../../shared/auto-update';

/** Keep frequent download progress updates local to the toolbar button. */
export function AutoUpdateAction({ className }: { className: string }) {
  const [state, setState] = useState<AutoUpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.tud.onAutoUpdateStateChanged((next) => {
      receivedEvent = true;
      if (!cancelled) {
        setState(next);
        setActionError(null);
      }
    });
    void window.tud
      .getAutoUpdateState()
      .then((next) => {
        if (!cancelled && !receivedEvent) setState(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const action = getUpdateToolbarAction(state);
  if (!action) return null;

  const runAction = async () => {
    if (!action.request || requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setActionError(null);
    try {
      switch (action.request) {
        case 'download':
          setState(await window.tud.downloadAndInstallUpdate());
          break;
        case 'install':
          await window.tud.installDownloadedUpdate();
          break;
        case 'check':
          setState(await window.tud.checkForUpdates());
          break;
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '更新失败，请重试');
    } finally {
      requestPending.current = false;
      setPending(false);
    }
  };

  return (
    <button
      aria-busy={pending || !action.request}
      className={className}
      disabled={pending || !action.request}
      onClick={() => {
        void runAction();
      }}
      title={
        actionError ?? state?.message ??
        (state?.version ? `更新至 v${state.version}` : action.label)
      }
      type="button"
    >
      {actionError ? '重试更新' : action.label}
    </button>
  );
}

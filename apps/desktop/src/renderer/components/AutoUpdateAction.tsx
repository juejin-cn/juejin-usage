import { useEffect, useRef, useState } from 'react';
import {
  getUpdateToolbarAction,
  PORTABLE_RELEASES_URL,
  type AutoUpdateState,
} from '../../shared/auto-update';
import { resolveAutoUpdateStateForUi } from '@/lib/mock-portable-update';

/** Keep frequent download progress updates local to the toolbar button. */
export function AutoUpdateAction({ className }: { className: string }) {
  const [state, setState] = useState<AutoUpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const requestPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.tud.onAutoUpdateStateChanged((next) => {
      receivedEvent = true;
      if (!cancelled) {
        setState(resolveAutoUpdateStateForUi(next));
        setActionError(null);
      }
    });
    void window.tud
      .getAutoUpdateState()
      .then((next) => {
        if (!cancelled && !receivedEvent) setState(resolveAutoUpdateStateForUi(next));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const action = getUpdateToolbarAction(state);
  if (!action) return null;

  const tip =
    actionError
    ?? state?.message
    ?? (state?.version ? `更新至 v${state.version}` : action.label);

  const runAction = async () => {
    if (!action.request || requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setActionError(null);
    try {
      switch (action.request) {
        case 'install':
          await window.tud.installDownloadedUpdate();
          break;
        case 'check':
          setState(resolveAutoUpdateStateForUi(await window.tud.checkForUpdates()));
          break;
        case 'open-releases': {
          const result = await window.tud.openExternal(PORTABLE_RELEASES_URL);
          if (!result.ok) {
            setActionError(result.message ?? '无法打开下载页');
          }
          break;
        }
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '更新失败，请重试');
    } finally {
      requestPending.current = false;
      setPending(false);
    }
  };

  // Native `title` and HeroUI Tooltip are unreliable on this Electron chrome row;
  // keep a local hover bubble instead.
  return (
    <div
      className="desktop-window-no-drag relative inline-flex"
      onMouseEnter={() => setTipOpen(true)}
      onMouseLeave={() => setTipOpen(false)}
    >
      <button
        aria-busy={pending || !action.request}
        aria-label={tip}
        className={className}
        disabled={pending || !action.request}
        onClick={() => {
          void runAction();
        }}
        type="button"
      >
        {actionError ? '重试更新' : action.label}
      </button>
      {tipOpen ? (
        <div
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 w-max max-w-64 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-[11px] leading-snug text-background shadow-md"
          role="tooltip"
        >
          {tip}
        </div>
      ) : null}
    </div>
  );
}

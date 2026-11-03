import { useEffect, useRef, useState } from 'react';
import { useTauriUpdateStatus } from '@/hooks/useTauriUpdateStatus';
import { getTauriUpdateToolbarAction } from '@/lib/tauri-update';

/** Keep progress updates local to the toolbar, just like Electron. */
export function TauriUpdateAction({ className }: { className: string }) {
  const { bridge, status, setStatus } = useTauriUpdateStatus();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const requestPending = useRef(false);
  useEffect(() => { setActionError(null); }, [status]);
  const action = getTauriUpdateToolbarAction(status);
  if (!bridge || !action) return null;

  const tip = actionError ?? status?.message
    ?? (status?.availableVersion ? `更新至 v${status.availableVersion}` : action.label);

  const runAction = async () => {
    if (!action.request || requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setActionError(null);
    try {
      if (action.request === 'install') await bridge.installUpdate();
      else setStatus(await bridge.checkForUpdates());
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason || '更新失败，请重试'));
    } finally {
      requestPending.current = false;
      setPending(false);
    }
  };

  return (
    <div
      className="desktop-window-no-drag relative inline-flex"
      onMouseEnter={() => setTipOpen(true)}
      onMouseLeave={() => setTipOpen(false)}
      onFocus={() => setTipOpen(true)}
      onBlur={() => setTipOpen(false)}
    >
      <button
        aria-busy={pending || !action.request}
        aria-label={tip}
        className={className}
        disabled={pending || !action.request}
        onClick={() => { void runAction(); }}
        type="button"
      >
        {actionError ? '重试更新' : action.label}
      </button>
      {tipOpen && (
        <div
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 w-max max-w-64 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-[11px] leading-snug text-background shadow-md"
          role="tooltip"
        >
          {tip}
        </div>
      )}
    </div>
  );
}

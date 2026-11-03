import { useEffect, useState } from 'react';
import { getTauriDesktopBridge, type TauriUpdateSnapshot } from '@/lib/tauri-desktop';

export function useTauriUpdateStatus() {
  const bridge = getTauriDesktopBridge();
  const [status, setStatus] = useState<TauriUpdateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let received = false;
    const stop = bridge.onUpdateStatus((next) => {
      received = true;
      if (!disposed) { setStatus(next); setError(null); }
    });
    void bridge.getUpdateStatus().then((next) => {
      if (!disposed && !received) setStatus(next);
    }).catch(() => { if (!disposed) setError('读取更新状态失败'); });
    return () => { disposed = true; stop(); };
  }, [bridge]);
  return { bridge, status, error, setError, setStatus };
}

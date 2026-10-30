import { useEffect, useRef, useState } from 'react';
import { Button, Surface } from '@heroui/react';
import { useAppToastQueue } from './AppToastContext';
import { getTauriDesktopBridge, type TauriUpdateSnapshot } from '@/lib/tauri-desktop';

function useUpdateStatus() {
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

function updateAction(status: TauriUpdateSnapshot | null) {
  if (!status) return null;
  switch (status.status) {
    case 'available':
    case 'downloaded': return { label: '安装并重启', enabled: true };
    case 'installing': return { label: '正在重启…', enabled: false };
    case 'downloading': {
      const percent = status.totalBytes
        ? Math.min(100, Math.round((status.downloadedBytes ?? 0) / status.totalBytes * 100))
        : null;
      return { label: percent === null ? '正在下载…' : `下载 ${percent}%`, enabled: false };
    }
    case 'error': return status.availableVersion ? { label: '重试安装', enabled: true } : null;
    default: return null;
  }
}

export function TauriUpdateSettings() {
  const { bridge, status, error, setError, setStatus } = useUpdateStatus();
  const [pending, setPending] = useState(false);
  if (!bridge) return null;
  const busy = pending || status?.status === 'checking' || status?.status === 'downloading' || status?.status === 'installing';
  const action = updateAction(status);
  const latestVersion = status?.availableVersion &&
    ['available', 'downloaded', 'downloading', 'installing', 'error'].includes(status.status)
    ? status.availableVersion : null;
  const message = error ?? (status?.status === 'error' ? status.message ?? '更新失败，请稍后重试' : null);

  const check = async () => {
    if (busy) return;
    setPending(true); setError(null);
    try { setStatus(await bridge.checkForUpdates()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason || '检查更新失败')); }
    finally { setPending(false); }
  };
  const install = async () => {
    if (busy) return;
    setPending(true); setError(null);
    try { await bridge.installUpdate(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason || '安装更新失败')); }
    finally { setPending(false); }
  };

  return (
    <Surface variant="secondary" className="flex flex-col gap-3 rounded-xl p-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">应用更新</h3>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline"
            isDisabled={!status || status.status === 'disabled' || busy || status.status === 'downloaded'}
            isPending={status?.status === 'checking'} onPress={() => { void check(); }}>
            检查更新
          </Button>
          {action && <Button size="sm" variant="primary" isDisabled={busy || !action.enabled}
            onPress={() => { void install(); }}>{action.label}</Button>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-muted">当前版本</span>
        <span className="font-mono text-xs">v{status?.currentVersion ?? '—'}</span>
      </div>
      {latestVersion && <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-muted">最新版本</span>
        <span className="font-mono text-xs">v{latestVersion}</span>
      </div>}
      {status?.status === 'disabled' && <p className="text-xs text-muted">此安装包未启用自动更新。</p>}
      {message && <p role="alert" className="text-sm text-danger">{message}</p>}
    </Surface>
  );
}

export function TauriUpdateNotice() {
  const { bridge, status } = useUpdateStatus();
  const queue = useAppToastQueue();
  const seen = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => { setActionError(null); }, [status]);
  useEffect(() => {
    if (!status?.completedVersion || !bridge || seen.current === status.completedVersion) return;
    seen.current = status.completedVersion;
    queue.add({ title: `已更新至 v${status.completedVersion}`, variant: 'success' });
    void bridge.acknowledgeUpdateCompleted().catch(() => {});
  }, [status?.completedVersion, bridge, queue]);

  if (!bridge || !status || !['available', 'downloaded', 'downloading', 'installing', 'error'].includes(status.status)) return null;
  const action = updateAction(status);
  const message = actionError ?? (status.status === 'available'
    ? `发现新版本 v${status.availableVersion}`
    : status.status === 'downloaded'
      ? `新版本 v${status.availableVersion} 已就绪`
      : status.status === 'downloading'
        ? action?.label ?? '正在下载…'
        : status.status === 'installing'
          ? '正在安装，即将重启…'
          : status.message ?? '更新失败，请稍后重试');
  const runAction = async () => {
    if (pending) return;
    setPending(true); setActionError(null);
    try {
      if (action?.enabled) await bridge.installUpdate();
      else await bridge.checkForUpdates();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason || '更新失败'));
    } finally { setPending(false); }
  };
  return <div role="status" className="z-50 flex shrink-0 items-center justify-between gap-3 border-b border-separator bg-surface px-4 py-2 text-sm text-foreground">
    <span>{message}</span>
    {(action?.enabled || status.status === 'error') && <Button size="sm" variant="tertiary"
      isDisabled={pending} onPress={() => { void runAction(); }}>
      {action?.enabled ? action.label : '重试'}
    </Button>}
  </div>;
}

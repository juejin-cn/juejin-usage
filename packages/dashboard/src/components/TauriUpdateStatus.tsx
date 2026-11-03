import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '@heroui/react';
import { useAppToastQueue } from './AppToastContext';
import { useTauriUpdateStatus } from '@/hooks/useTauriUpdateStatus';
import { getTauriUpdateToolbarAction } from '@/lib/tauri-update';
import { SettingsInfoRow } from './SettingsInfoRow';
import { StatusBanner } from './StatusBanner';

export function TauriUpdateSettings() {
  const { bridge, status, error, setError, setStatus } = useTauriUpdateStatus();
  const [pending, setPending] = useState(false);
  if (!bridge) return null;
  const busy = pending || status?.status === 'checking' || status?.status === 'downloading' || status?.status === 'installing';
  const action = status?.status === 'error' ? null : getTauriUpdateToolbarAction(status);
  const latestVersion = status?.availableVersion &&
    ['available', 'downloaded', 'downloading', 'installing'].includes(status.status)
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
    <Card variant="tertiary" className="rounded-xl shadow-none">
      <Card.Header>
        <div className="flex w-full items-center justify-between gap-4">
          <Card.Title>应用更新</Card.Title>
          <div className="flex shrink-0 items-center gap-2">
            <Button className="shrink-0" size="sm" variant="outline"
              isDisabled={!status || status.status === 'disabled' || busy || status.status === 'downloaded'}
              isPending={status?.status === 'checking'} onPress={() => { void check(); }}>
              检查更新
            </Button>
            {action && <Button className="shrink-0" size="sm" variant="primary"
              aria-busy={pending || !action.request} isDisabled={busy || !action.request}
              onPress={() => {
                if (action.request === 'install') void install();
                else if (action.request === 'check') void check();
              }}>{action.label}</Button>}
          </div>
        </div>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <SettingsInfoRow label="当前版本" value={`v${status?.currentVersion ?? '—'}`} />
        {latestVersion && <SettingsInfoRow label="最新版本" value={`v${latestVersion}`} />}
        {message && <StatusBanner tone="error" title="更新失败" description={message} />}
        {status?.status === 'disabled' && <p className="text-xs text-muted">此安装包未启用自动更新。</p>}
      </Card.Content>
    </Card>
  );
}

/** Match Electron: only show a one-time completion toast, no page-wide banner. */
export function TauriUpdateNotice() {
  const { bridge, status } = useTauriUpdateStatus();
  const queue = useAppToastQueue();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!status?.completedVersion || !bridge || seen.current === status.completedVersion) return;
    seen.current = status.completedVersion;
    queue.add({ title: `已更新至 v${status.completedVersion}`, variant: 'success' });
    void bridge.acknowledgeUpdateCompleted().catch(() => {});
  }, [status?.completedVersion, bridge, queue]);
  return null;
}

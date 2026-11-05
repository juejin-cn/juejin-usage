import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card } from '@heroui/react';
import { useAppToastQueue } from './AppToastContext';
import { useTauriUpdateStatus } from '@/hooks/useTauriUpdateStatus';
import {
  getTauriLatestUpdateVersion,
  getTauriUpdateStatusMessage,
  getTauriUpdateToolbarAction,
} from '@/lib/tauri-update';
import { SettingsInfoRow } from './SettingsInfoRow';

export function TauriUpdateSettings() {
  const { bridge, status, error, setError, setStatus } = useTauriUpdateStatus();
  const [installPending, setInstallPending] = useState(false);
  if (!bridge) return null;

  const phase = status?.status ?? 'idle';
  const busy =
    phase === 'checking'
    || phase === 'downloading'
    || phase === 'downloaded'
    || phase === 'installing';
  // Check failures can be retried with the persistent check button.
  const updateAction = phase === 'error' ? null : getTauriUpdateToolbarAction(status);
  const latestVersion = getTauriLatestUpdateVersion(status);
  const statusMessage = getTauriUpdateStatusMessage(status);
  const errorMessage = error ?? (phase === 'error' ? status?.message : null);

  const check = async () => {
    setError(null);
    try {
      setStatus(await bridge.checkForUpdates());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason || '检查更新失败'));
    }
  };

  const install = async () => {
    setError(null);
    setInstallPending(true);
    try {
      await bridge.installUpdate();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason || '更新并重启失败'));
    } finally {
      setInstallPending(false);
    }
  };

  return (
    <Card className="rounded-xl shadow-none" variant="tertiary">
      <Card.Header>
        <div className="flex w-full items-center justify-between gap-4">
          <Card.Title>应用更新</Card.Title>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              className="shrink-0"
              isDisabled={!status || phase === 'disabled' || busy || installPending}
              isPending={phase === 'checking'}
              onPress={() => {
                void check();
              }}
              size="sm"
              variant="outline"
            >
              检查更新
            </Button>
            {updateAction ? (
              <Button
                aria-busy={installPending || updateAction.request === null}
                className="shrink-0"
                isDisabled={installPending || updateAction.request === null}
                onPress={() => {
                  if (updateAction.request === 'install') void install();
                  if (updateAction.request === 'check') void check();
                }}
                size="sm"
                variant="primary"
              >
                {updateAction.label}
              </Button>
            ) : null}
          </div>
        </div>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <SettingsInfoRow label="当前版本" value={`v${status?.currentVersion ?? '—'}`} />
        {latestVersion ? (
          <SettingsInfoRow label="最新版本" value={`v${latestVersion}`} />
        ) : null}

        {errorMessage ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>更新失败</Alert.Title>
              <Alert.Description>{errorMessage}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        {statusMessage ? (
          <p className="text-xs text-muted">{statusMessage}</p>
        ) : null}
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
    queue.add({
      title: `已更新至 v${status.completedVersion}`,
      description: '新版本已安装完成。',
      variant: 'success',
    });
    void bridge.acknowledgeUpdateCompleted().catch(() => {});
  }, [status?.completedVersion, bridge, queue]);
  return null;
}

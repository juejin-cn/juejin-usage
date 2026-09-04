import { Button, Label, Modal, ProgressBar } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import {
  updateDownloadPercent,
  type AutoUpdateState,
} from '../../shared/auto-update';

const OPEN_MODAL_STATUSES = new Set([
  'available',
  'downloading',
  'downloaded',
  'installing',
]);

const CLOSE_MODAL_STATUSES = new Set([
  'unsupported',
  'idle',
  'skipped',
  'not-available',
]);

function versionLabel(version: string | undefined): string {
  return version ? `v${version}` : '—';
}

export function AutoUpdateModal() {
  const [state, setState] = useState<AutoUpdateState | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    'download' | 'skip' | 'install' | 'retry' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const applyState = useCallback((next: AutoUpdateState) => {
    setState(next);
    if (OPEN_MODAL_STATUSES.has(next.status)) {
      setIsOpen(true);
    } else if (CLOSE_MODAL_STATUSES.has(next.status)) {
      setIsOpen(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.tud.onAutoUpdateStateChanged((next) => {
      if (!cancelled) applyState(next);
    });
    void window.tud
      .getAutoUpdateState()
      .then((next) => {
        if (!cancelled) applyState(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyState]);

  const runAction = async (
    action: NonNullable<typeof pendingAction>,
    request: () => Promise<AutoUpdateState | void>,
  ) => {
    setPendingAction(action);
    setActionError(null);
    try {
      const next = await request();
      if (next) applyState(next);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '请稍后再试');
    } finally {
      setPendingAction(null);
    }
  };

  const status = state?.status;
  const version = state?.version;
  const busy = pendingAction != null;
  const downloadPercent = updateDownloadPercent(state?.percent);
  const errorMessage = actionError ?? state?.message;

  return (
    <Modal.Backdrop
      isDismissable={false}
      isKeyboardDismissDisabled
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      variant="blur"
    >
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header className="pb-2">
            <Modal.Heading>
              {actionError || status === 'error'
                ? '更新遇到问题'
                : status === 'downloaded'
                ? '更新已就绪'
                : status === 'downloading'
                  ? '正在下载更新'
                  : status === 'installing'
                    ? '正在重启并更新'
                    : '发现新版本'}
            </Modal.Heading>
          </Modal.Header>

          <Modal.Body className="space-y-5 pb-2 text-sm leading-6 text-muted">
            {status !== 'error' && (
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-xl border border-default bg-surface-secondary/50 px-4 py-3">
                <div>
                  <p className="text-xs text-muted">当前版本</p>
                  <p className="font-mono font-medium text-foreground">
                    {versionLabel(state?.currentVersion)}
                  </p>
                </div>
                <span aria-hidden="true" className="text-muted">
                  →
                </span>
                <div className="text-right">
                  <p className="text-xs text-muted">新版本</p>
                  <p className="font-mono font-medium text-accent">
                    {versionLabel(version)}
                  </p>
                </div>
              </div>
            )}

            {status === 'available' && !actionError && (
              <p>
                点击“下载并更新”后，应用会先下载更新包，完成后自动重启安装。你也可以跳过这个版本；有更高版本发布时仍会再次提醒。
              </p>
            )}

            {status === 'downloading' && !actionError && (
              <ProgressBar
                aria-label="更新下载进度"
                isIndeterminate={state?.percent == null}
                size="sm"
                value={downloadPercent}
              >
                <Label>下载 {versionLabel(version)}</Label>
                <ProgressBar.Output />
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            )}

            {status === 'downloaded' && !actionError && (
              <>
                <p>
                  更新包已经下载完成。重启前本地服务会继续运行；点击后应用将退出并完成安装。
                </p>
                {state?.message && (
                  <p
                    className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-warning"
                    role="alert"
                  >
                    {state.message}
                  </p>
                )}
              </>
            )}

            {status === 'installing' && !actionError && (
              <p role="status">正在安全停止本地服务，应用随后会自动重启。</p>
            )}

            {status === 'checking' && !actionError && (
              <p role="status">正在重新检查可用版本，请稍候。</p>
            )}

            {status === 'error' && (
              <p
                className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-danger"
                role="alert"
              >
                {errorMessage ?? '检查更新失败，请稍后重试。'}
              </p>
            )}

            {actionError && status !== 'error' && (
              <p
                className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-danger"
                role="alert"
              >
                {actionError}
              </p>
            )}
          </Modal.Body>

          <Modal.Footer className="gap-2">
            {status === 'available' && !actionError && (
              <>
                <Button
                  isDisabled={busy}
                  isPending={pendingAction === 'skip'}
                  onPress={() => {
                    void runAction('skip', () => window.tud.skipUpdate());
                  }}
                  variant="tertiary"
                >
                  跳过此版本
                </Button>
                <Button
                  isDisabled={busy}
                  isPending={pendingAction === 'download'}
                  onPress={() => {
                    void runAction('download', () =>
                      window.tud.downloadAndInstallUpdate(),
                    );
                  }}
                  variant="primary"
                >
                  下载并更新
                </Button>
              </>
            )}

            {status === 'downloading' && !actionError && (
              <Button isDisabled isPending variant="primary">
                正在下载
              </Button>
            )}

            {status === 'downloaded' && !actionError && (
              <>
                <Button
                  isDisabled={busy}
                  isPending={pendingAction === 'skip'}
                  onPress={() => {
                    void runAction('skip', () => window.tud.skipUpdate());
                  }}
                  variant="tertiary"
                >
                  跳过此版本
                </Button>
                <Button
                  isDisabled={busy}
                  isPending={pendingAction === 'install'}
                  onPress={() => {
                    void runAction('install', () =>
                      window.tud.installDownloadedUpdate(),
                    );
                  }}
                  variant="primary"
                >
                  重启并更新
                </Button>
              </>
            )}

            {status === 'installing' && !actionError && (
              <Button isDisabled isPending variant="primary">
                正在重启
              </Button>
            )}

            {(status === 'error' || actionError) && (
              <>
                <Button onPress={() => setIsOpen(false)} variant="tertiary">
                  稍后处理
                </Button>
                <Button
                  isDisabled={busy}
                  isPending={pendingAction === 'retry'}
                  onPress={() => {
                    void runAction('retry', () =>
                      window.tud.checkForUpdates(),
                    );
                  }}
                  variant="primary"
                >
                  重新检查
                </Button>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

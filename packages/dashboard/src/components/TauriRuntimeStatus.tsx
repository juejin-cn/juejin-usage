import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { useAppToastQueue } from './AppToastContext';
import { getTauriDesktopBridge, type TauriRuntimeSnapshot } from '@/lib/tauri-desktop';

/** Native-only recovery UI; reads a snapshot so early startup events aren't lost. */
export function TauriRuntimeStatus() {
  const bridge = getTauriDesktopBridge();
  const queue = useAppToastQueue();
  const [status, setStatus] = useState<TauriRuntimeSnapshot | null>(null);
  const lastNoticeId = useRef<number | null>(null);
  const lastPhase = useRef<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false, received = false;
    const apply = (next: TauriRuntimeSnapshot) => {
      if (disposed) return;
      if (next.phase === 'ready' && lastPhase.current === 'recovering') {
        queue.add({ title: '本地服务已恢复', variant: 'success' });
      }
      lastPhase.current = next.phase;
      setStatus(next);
    };
    const stop = bridge.onRuntimeStatus(next => { received = true; apply(next); });
    void bridge.getRuntimeStatus().then(next => { if (!received) apply(next); }).catch(() => {});
    const notice = () => {
      void bridge.getRuntimeNotice().then(notice => {
        if (disposed || notice === null || lastNoticeId.current === notice.id) return;
        lastNoticeId.current = notice.id;
        queue.add({ title: '本地配置已修复', description: notice.tokenSalvaged ? '账号凭据已保留，请检查同步设置。' : '请重新关联掘金账号。', variant: 'warning' });
        void bridge.acknowledgeRuntimeNotice(notice.id).catch(() => {});
      }).catch(() => {});
    };
    const stopNotice = bridge.onRuntimeNotice(notice);
    const stopError = bridge.onShellError(message => queue.add({ title: '操作失败', description: message, variant: 'danger' }));
    notice();
    return () => { disposed = true; stop(); stopNotice(); stopError(); };
  }, [bridge, queue]);
  if (!bridge || !status || status.phase === 'ready') return null;
  const failed = status.phase === 'failed' || status.phase === 'stopped';
  return (
    <div role="status" aria-live="polite" className="z-50 flex shrink-0 items-center justify-between gap-3 border-b border-separator bg-surface px-4 py-2 text-sm text-foreground">
      <span>{failed ? status.reason === 'ownership' ? '其他桌面客户端正在运行，请先退出后重试。' : '本地服务已停止，请重试。' : status.phase === 'recovering' ? '本地服务正在恢复…' : '本地服务正在启动…'}</span>
      {failed && <Button size="sm" variant="tertiary" onPress={() => { void bridge.retryRuntime().catch(() => queue.add({ title: '无法重启本地服务', variant: 'danger' })); }}>重试</Button>}
    </div>
  );
}

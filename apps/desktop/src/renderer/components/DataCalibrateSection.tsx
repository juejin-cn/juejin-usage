import { useCallback, useMemo, useState } from 'react';
import { Button, Modal, Surface } from '@heroui/react';
import {
  applyCalibrate,
  fetchCalibratePreview,
  type CalibratePreviewResponse,
} from '@/lib/api';
import { formatReconcileSkipReason } from '@juejin-opensource/jusage-core/reconcile-skip';

function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function applicableDates(preview: CalibratePreviewResponse): string[] {
  return preview.days.filter((day) => !day.outOfIngestWindow).map((day) => day.date);
}

function summarizeDiff(preview: CalibratePreviewResponse): string {
  const s = preview.summary;
  if (s.diffDayCount === 0) return '近 90 天本机与线上一致。';
  const parts: string[] = [];
  if (s.onlineMissingDays > 0) {
    parts.push(
      `线上缺失 ${s.onlineMissingDays} 天（Token ${formatTokens(s.onlineMissingTokens)}）`,
    );
  }
  if (s.onlineOnlyDays > 0) {
    parts.push(
      `线上多出 ${s.onlineOnlyDays} 天（Token ${formatTokens(s.onlineOnlyTokens)}）`,
    );
  }
  if (s.mismatchDays > 0) {
    parts.push(
      `构成不一致 ${s.mismatchDays} 天（Token Δ ${formatTokens(s.mismatchTokenDelta)}）`,
    );
  }
  return `近 90 天共 ${s.diffDayCount} 天有差异：${parts.join('；')}。`;
}

export function DataCalibrateSection({
  linked,
  onNotify,
}: {
  linked: boolean;
  onNotify: (toast: {
    title: string;
    description?: string;
    variant: 'success' | 'danger';
  }) => void;
}) {
  const [preview, setPreview] = useState<CalibratePreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dates = useMemo(
    () => (preview ? applicableDates(preview) : []),
    [preview],
  );

  const runPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    setConfirmOpen(false);
    try {
      const data = await fetchCalibratePreview();
      setPreview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '校验失败');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const onApply = async () => {
    if (dates.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const result = await applyCalibrate(dates);
      setPreview(result.preview);
      setConfirmOpen(false);
      const skipped = result.skipped ?? 0;
      const parts = [
        `删除 ${result.deleted}`,
        `写入 ${result.upserted}`,
      ];
      if (skipped > 0) {
        parts.push(`跳过 ${skipped} 条异常事件`);
      }
      onNotify({
        title: skipped > 0 ? '校对完成（有跳过）' : '校对完成',
        description: parts.join(' · '),
        variant: 'success',
      });
      if (skipped > 0) {
        const rows = result.skippedEvents ?? [];
        // Full list for support / repro; toast stays short above.
        console.warn('[calibrate] skipped events', rows);
        const lines = rows.map((row) => formatReconcileSkipReason(row));
        const shown = lines.slice(0, 8);
        const more =
          lines.length > shown.length
            ? `\n…另有 ${lines.length - shown.length} 条，详见控制台 [calibrate] skipped events`
            : '';
        setError(
          `有 ${skipped} 条异常事件已跳过，其余已按本地覆盖：\n${shown.join('\n')}${more}`,
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '校对失败';
      setError(message);
      setConfirmOpen(false);
      onNotify({
        title: '校对失败',
        description: message,
        variant: 'danger',
      });
    } finally {
      setApplying(false);
    }
  };

  if (!linked) {
    return (
      <Surface className="rounded-xl p-4" variant="secondary">
        <h3 className="text-sm text-foreground">数据校验</h3>
        <p className="mt-1 text-xs text-muted">
          关联掘金账号后，可校验本机与线上近 90 天是否一致。
        </p>
      </Surface>
    );
  }

  return (
    <>
      <Surface className="rounded-xl p-4" variant="secondary">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm text-foreground">数据校验</h3>
            <p className="mt-1 text-xs text-muted">
              对比本机与线上近 90 天，仅校准当前设备。
            </p>
          </div>
          <Button
            isDisabled={loading || applying}
            onPress={() => void runPreview()}
            size="sm"
            variant="outline"
          >
            {loading ? '校验中…' : '校验'}
          </Button>
        </div>

        {error ? (
          <p className="mt-3 whitespace-pre-wrap break-all text-xs text-danger">
            {error}
          </p>
        ) : null}

        {preview ? (
          <div className="mt-3 space-y-3">
            <p className="break-all font-mono text-[11px] text-muted">
              本机 deviceId：{preview.deviceId}
            </p>
            <p className="text-xs leading-5 text-foreground">
              {summarizeDiff(preview)}
            </p>
            {preview.otherOnlineDevices.length > 0 ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                线上另有 {preview.otherOnlineDevices.length}{' '}
                台设备未纳入（仅校对本机）。
              </p>
            ) : null}
            {dates.length > 0 ? (
              <div className="flex justify-end">
                <Button
                  isDisabled={applying || loading}
                  onPress={() => setConfirmOpen(true)}
                  size="sm"
                  variant="primary"
                >
                  确定校对，以本地为准
                </Button>
              </div>
            ) : preview.summary.diffDayCount > 0 ? (
              <p className="text-xs text-muted">差异均在线上保留窗外，无法覆盖。</p>
            ) : null}
          </div>
        ) : null}
      </Surface>

      <Modal.Backdrop isOpen={confirmOpen} onOpenChange={setConfirmOpen}>
        <Modal.Container size="sm">
          <Modal.Dialog className="max-w-md">
            <Modal.Header>
              <Modal.Heading>确认以本地为准覆盖</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-2 text-sm text-muted">
              <p>
                将覆盖线上本机近 90 天中有差异的 {dates.length}{' '}
                天：补齐缺失、删除线上多出、改写构成不一致。
              </p>
              <p className="break-all font-mono text-xs">
                deviceId：{preview?.deviceId ?? '—'}
              </p>
              <p>此操作以本地数据为准，操作后不可撤销。</p>
            </Modal.Body>
            <Modal.Footer>
              <Button
                isDisabled={applying}
                onPress={() => setConfirmOpen(false)}
                variant="outline"
              >
                取消
              </Button>
              <Button
                isDisabled={applying}
                onPress={() => void onApply()}
                variant="primary"
              >
                {applying ? '校对中…' : '确认覆盖'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Modal, Surface } from '@heroui/react';
import {
  applyCalibrate,
  fetchCalibratePreview,
  type CalibrateDaySummary,
  type CalibratePreviewResponse,
} from '@/lib/api';

type DayFilter = 'all' | 'online_missing' | 'online_only' | 'mismatch';

function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function kindLabel(kind: string): string {
  if (kind === 'online_missing') return '线上缺失';
  if (kind === 'online_only') return '线上独有';
  if (kind === 'mismatch') return '构成不一致';
  return kind;
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [preview, setPreview] = useState<CalibratePreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [filter, setFilter] = useState<DayFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCalibratePreview();
      setPreview(data);
      setSelected(new Set());
      setFilter('all');
    } catch (e) {
      setError(e instanceof Error ? e.message : '对比失败');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!panelOpen || !linked) return;
    void runPreview();
  }, [panelOpen, linked, runPreview]);

  const filteredDays = useMemo(() => {
    const days = preview?.days ?? [];
    if (filter === 'all') return days;
    return days.filter((d) => d.kinds.includes(filter));
  }, [preview, filter]);

  const toggleDate = (date: string, enabled: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (enabled) next.add(date);
      else next.delete(date);
      return next;
    });
  };

  const selectFiltered = () => {
    setSelected(
      new Set(
        filteredDays.filter((d) => !d.outOfIngestWindow).map((d) => d.date),
      ),
    );
  };

  const clearSelection = () => setSelected(new Set());

  const onApply = async () => {
    const dates = [...selected].sort();
    if (dates.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const result = await applyCalibrate(dates);
      setPreview(result.preview);
      setSelected(new Set());
      setConfirmOpen(false);
      onNotify({
        title: '校准完成',
        description: `删除 ${result.deleted} · 写入 ${result.upserted}`,
        variant: 'success',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '校准失败');
      setConfirmOpen(false);
      onNotify({
        title: '校准失败',
        description: e instanceof Error ? e.message : undefined,
        variant: 'danger',
      });
    } finally {
      setApplying(false);
    }
  };

  const onPanelOpenChange = (open: boolean) => {
    setPanelOpen(open);
    if (!open) {
      setConfirmOpen(false);
      setError(null);
    }
  };

  if (!linked) {
    return (
      <Surface className="rounded-xl p-4" variant="secondary">
        <h3 className="text-sm text-foreground">数据校准</h3>
        <p className="mt-1 text-xs text-muted">
          关联掘金账号后，可按本机设备对比并覆盖线上数据。
        </p>
      </Surface>
    );
  }

  const summary = preview?.summary;

  return (
    <>
      <Surface className="rounded-xl p-4" variant="secondary">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm text-foreground">数据校准</h3>
            <p className="mt-1 text-xs text-muted">
              校准以同设备本地数据为准。在弹窗中对比差异并手动覆盖线上。
            </p>
          </div>
          <Button
            onPress={() => setPanelOpen(true)}
            size="sm"
            variant="secondary"
          >
            数据校准
          </Button>
        </div>
      </Surface>

      <Modal.Backdrop
        isOpen={panelOpen}
        onOpenChange={onPanelOpenChange}
        variant="opaque"
      >
        <Modal.Container scroll="inside" size="cover">
          <Modal.Dialog
            aria-label="数据校准"
            className="flex min-h-[min(720px,90vh)] flex-col sm:max-w-230"
          >
            <Modal.CloseTrigger aria-label="关闭数据校准" />
            <Modal.Header className="pr-10">
              <Modal.Heading>数据校准</Modal.Heading>
              <p className="mt-1 text-xs text-muted">
                以同设备本地数据为准。筛选并多选有差异的日期后，手动覆盖线上。
              </p>
              {preview?.deviceId ? (
                <p className="mt-1 break-all font-mono text-[11px] text-muted">
                  本机 deviceId：{preview.deviceId}
                </p>
              ) : null}
            </Modal.Header>

            <Modal.Body className="flex min-h-0 flex-1 flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted">
                  {loading
                    ? '正在对比本地与线上…'
                    : preview
                      ? `差异天数 ${summary?.diffDayCount ?? 0}`
                      : '尚未对比'}
                </p>
                <Button
                  isDisabled={loading || applying}
                  onPress={() => void runPreview()}
                  size="sm"
                  variant="secondary"
                >
                  {loading ? '对比中…' : '重新对比'}
                </Button>
              </div>

              {error ? (
                <p className="text-xs text-danger">{error}</p>
              ) : null}

              {summary ? (
                <div className="space-y-1.5 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-foreground">
                  <p>
                    线上缺失：{summary.onlineMissingDays} 天 /{' '}
                    {summary.onlineMissingRows} 行 / Token{' '}
                    {formatTokens(summary.onlineMissingTokens)}
                  </p>
                  <p>
                    线上独有：{summary.onlineOnlyDays} 天 /{' '}
                    {summary.onlineOnlyRows} 行 / Token{' '}
                    {formatTokens(summary.onlineOnlyTokens)}
                  </p>
                  <p>
                    构成不一致：{summary.mismatchDays} 天 /{' '}
                    {summary.mismatchRows} 行 / Token Δ{' '}
                    {formatTokens(summary.mismatchTokenDelta)}
                    {summary.mismatchReportedCostDeltaUsd != null
                      ? ` · Cost Δ $${summary.mismatchReportedCostDeltaUsd.toFixed(4)}`
                      : ''}
                  </p>
                  {preview && preview.otherOnlineDevices.length > 0 ? (
                    <p className="pt-1 text-amber-600 dark:text-amber-400">
                      线上另有 {preview.otherOnlineDevices.length}{' '}
                      台设备未纳入本次对齐（仅校准当前本机）。
                    </p>
                  ) : null}
                </div>
              ) : null}

              {preview ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ['all', '全部'],
                        ['online_missing', '线上缺失'],
                        ['online_only', '线上独有'],
                        ['mismatch', '构成不一致'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        className={`rounded-full px-2.5 py-1 text-[11px] ${
                          filter === key
                            ? 'bg-accent text-accent-foreground'
                            : 'bg-muted/40 text-muted'
                        }`}
                        key={key}
                        onClick={() => setFilter(key)}
                        type="button"
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      className="rounded-full px-2.5 py-1 text-[11px] text-muted underline"
                      onClick={selectFiltered}
                      type="button"
                    >
                      全选当前筛选
                    </button>
                    <button
                      className="rounded-full px-2.5 py-1 text-[11px] text-muted underline"
                      onClick={clearSelection}
                      type="button"
                    >
                      清除选择
                    </button>
                  </div>

                  <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
                    {filteredDays.length === 0 ? (
                      <p className="text-xs text-muted">当前筛选无差异日期。</p>
                    ) : (
                      filteredDays.map((day) => (
                        <DayRow
                          day={day}
                          key={day.date}
                          selected={selected.has(day.date)}
                          onToggle={toggleDate}
                        />
                      ))
                    )}
                  </div>
                </>
              ) : loading ? null : (
                <p className="text-xs text-muted">
                  点击「重新对比」拉取本机与线上差异。
                </p>
              )}
            </Modal.Body>

            <Modal.Footer>
              <Button
                isDisabled={applying}
                onPress={() => onPanelOpenChange(false)}
                variant="secondary"
              >
                关闭
              </Button>
              <Button
                isDisabled={selected.size === 0 || applying || loading}
                onPress={() => setConfirmOpen(true)}
                variant="primary"
              >
                以本地为准校准所选日期（{selected.size}）
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={confirmOpen} onOpenChange={setConfirmOpen}>
        <Modal.Container size="sm">
          <Modal.Dialog className="max-w-md">
            <Modal.Header>
              <Modal.Heading>确认以本地为准覆盖</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-2 text-sm text-muted">
              <p>
                校准以同设备本地数据为准（deviceId=
                {preview?.deviceId ?? '—'}）。
              </p>
              <p>
                将覆盖线上该设备、所选 {selected.size}{' '}
                个日期内的数据：补齐缺失、删除线上独有、改写构成不一致（含
                Cursor 计费字段）。
              </p>
              <p className="break-all font-mono text-xs">
                {[...selected].sort().join(', ')}
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button
                isDisabled={applying}
                onPress={() => setConfirmOpen(false)}
                variant="secondary"
              >
                取消
              </Button>
              <Button
                isDisabled={applying}
                onPress={() => void onApply()}
                variant="primary"
              >
                {applying ? '校准中…' : '确认覆盖'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

function DayRow({
  day,
  selected,
  onToggle,
}: {
  day: CalibrateDaySummary;
  selected: boolean;
  onToggle: (date: string, enabled: boolean) => void;
}) {
  const disabled = day.outOfIngestWindow;
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      <Checkbox
        isDisabled={disabled}
        isSelected={selected}
        onChange={(checked) => onToggle(day.date, Boolean(checked))}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
      <button
        className="min-w-0 flex-1 text-left"
        disabled={disabled}
        onClick={() => onToggle(day.date, !selected)}
        type="button"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-foreground">{day.date}</span>
          {day.kinds.map((kind) => (
            <span
              className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted"
              key={kind}
            >
              {kindLabel(kind)}
            </span>
          ))}
          {disabled ? (
            <span className="text-[10px] text-amber-600">窗外不可对齐</span>
          ) : null}
        </div>
        <p className="mt-0.5 text-muted">
          缺失 {day.localOnlyRows} · 独有 {day.onlineOnlyRows} · 不一致{' '}
          {day.mismatchRows} · Token Δ {formatTokens(day.tokenDelta)}
          {day.reportedCostDeltaUsd != null
            ? ` · Cost Δ $${day.reportedCostDeltaUsd.toFixed(4)}`
            : ''}
        </p>
      </button>
    </div>
  );
}

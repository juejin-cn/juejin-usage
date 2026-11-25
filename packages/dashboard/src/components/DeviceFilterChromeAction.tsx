import type { ReactNode } from 'react';
import { Check, Copy, DisplayPulse } from '@gravity-ui/icons';
import { Button, Checkbox, Modal, Tooltip } from '@heroui/react';
import { useDeviceFilter } from '@/hooks/useDeviceFilter';
import { cn } from '@/lib/utils';

/**
 * Discreet multi-device filter (online Web only). Shown left of the download
 * icon when the account has more than one device_id online.
 * Selection is persisted in localStorage keyed by originUserId.
 */
export function DeviceFilterChromeAction({ renderTrigger }: {
  renderTrigger?: (open: () => void, activeCount: number) => ReactNode;
} = {}) {
  const { visible, devices, open, setOpen, openModal, activeCount, draft, setDraft,
    toggle, apply, copiedId, copyDeviceId } = useDeviceFilter();
  if (!visible) return null;

  return (
    <>
      {renderTrigger ? renderTrigger(openModal, activeCount) : (
      <Tooltip closeDelay={80} delay={100}>
        <Button
          aria-label="筛选设备"
          className={cn(
            'relative size-8 min-h-8 min-w-8 shrink-0 p-0',
          )}
          isIconOnly
          onPress={openModal}
          size="sm"
          variant="tertiary"
        >
          <DisplayPulse className="size-4" />
          {activeCount > 0 ? (
            <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" />
          ) : null}
        </Button>
        <Tooltip.Content placement="bottom">
          <p>{activeCount > 0 ? `已筛 ${activeCount} 台设备` : '筛选设备'}</p>
        </Tooltip.Content>
      </Tooltip>
      )}

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen} variant="opaque">
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>筛选设备</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-3">
              <p className="text-xs text-muted">
                勾选要查看的设备。清除全部勾选即查看全部设备。
              </p>
              <div className="flex gap-2">
                <Button
                  onPress={() =>
                    setDraft(
                      new Set(devices.map((d) => d.device_id.toLowerCase())),
                    )
                  }
                  size="sm"
                  variant="outline"
                >
                  全选
                </Button>
                <Button
                  onPress={() => setDraft(new Set())}
                  size="sm"
                  variant="outline"
                >
                  清除
                </Button>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {devices.map((device) => {
                  const id = device.device_id;
                  const key = id.toLowerCase();
                  const checked = draft.has(key);
                  const justCopied = copiedId === key;
                  return (
                    <div
                      className="flex items-start gap-2 rounded-lg border border-border/60 px-2 py-2 text-xs"
                      key={id}
                    >
                      <Checkbox
                        isSelected={checked}
                        onChange={(next) => toggle(id, Boolean(next))}
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                        </Checkbox.Content>
                      </Checkbox>
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => toggle(id, !checked)}
                        type="button"
                      >
                        <p className="break-all font-mono text-[11px] text-foreground">
                          {id}
                        </p>
                        <p className="mt-0.5 text-muted">
                          {device.event_count} 条 · 最近{' '}
                          {device.last_occurred_at?.slice(0, 10) ?? '—'}
                        </p>
                      </button>
                      <Tooltip closeDelay={60} delay={80}>
                        <Button
                          aria-label={justCopied ? '已复制' : '复制设备 ID'}
                          className="size-7 min-h-7 min-w-7 shrink-0 p-0"
                          isIconOnly
                          onPress={() => void copyDeviceId(id)}
                          size="sm"
                          variant="tertiary"
                        >
                          {justCopied ? (
                            <Check className="size-3.5 text-success" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </Button>
                        <Tooltip.Content placement="left">
                          <p>{justCopied ? '已复制' : '复制 ID'}</p>
                        </Tooltip.Content>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button onPress={() => setOpen(false)} variant="outline">
                取消
              </Button>
              <Button onPress={apply} variant="primary">
                应用
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

import type { ReactNode } from 'react';
import { IconCheck, IconCopy, IconDevices } from '@tabler/icons-react';
import { useDeviceFilter } from '@/hooks/useDeviceFilter';
import { UsageToolbarAction } from './UsageEmptyState';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';

export function DeviceFilterChromeAction() {
  const filter = useDeviceFilter();
  const { activeCount, visible } = filter;
  if (!visible) return null;

  const label = activeCount ? `设置管理（已选 ${activeCount} 台）` : '设置管理';
  return (
    <DeviceFilterDialog filter={filter}>
      <DialogTrigger render={<UsageToolbarAction className="relative" />} aria-label={label} title={label}>
        <IconDevices size={16} aria-hidden="true" />
        设置管理
        {activeCount > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" />}
      </DialogTrigger>
    </DeviceFilterDialog>
  );
}

export function DeviceFilterDialog({ filter, children }: { filter: ReturnType<typeof useDeviceFilter>; children?: ReactNode }) {
  const { devices, open, setOpen, openModal, draft, setDraft, toggle, apply, copiedId, copyDeviceId } = filter;
  return (
    <Dialog open={open} onOpenChange={next => next ? openModal() : setOpen(false)}>
      {children}
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4">
        <DialogHeader>
          <DialogTitle className="text-base">筛选设备</DialogTitle>
          <DialogDescription>选择要查看的设备。清除选择后显示全部设备。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDraft(new Set(devices.map(d => d.device_id.toLowerCase())))}>全选</Button>
          <Button variant="ghost" size="sm" onClick={() => setDraft(new Set())}>清除</Button>
          <span className="ml-auto text-muted">已选 {draft.size} / {devices.length}</span>
        </div>
        <div className="max-h-72 divide-y divide-border overflow-y-auto">
          {devices.map(device => {
            const id = device.device_id;
            const checked = draft.has(id.toLowerCase());
            const copied = copiedId === id.toLowerCase();
            return (
              <div key={id} className="flex items-center gap-2 py-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <Checkbox checked={checked} onCheckedChange={next => toggle(id, next)} aria-label={id} />
                  <span className="min-w-0">
                    <span className="block break-all">{id}</span>
                    <span className="text-muted">{device.event_count} 条 · 最近 {device.last_occurred_at?.slice(0, 10) ?? '—'}</span>
                  </span>
                </label>
                <Button variant="ghost" size="icon-sm" aria-label={copied ? '已复制' : '复制设备 ID'}
                  title={copied ? '已复制' : '复制设备 ID'} onClick={() => void copyDeviceId(id)}>
                  {copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
                </Button>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>取消</DialogClose>
          <Button className="h-9 rounded-[4px] bg-[#1e80ff] px-4 text-sm font-normal text-white hover:bg-[#1171ee] active:bg-[#0c5dca]" onClick={apply}>立即应用</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

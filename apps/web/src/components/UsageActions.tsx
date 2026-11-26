import { useState } from 'react';
import { shareCurrentPage } from '@/lib/shell-events';
import { UsageToolbarAction } from './UsageEmptyState';
import { IconCards, IconDevices, IconDotsVertical, IconPrinter } from '@tabler/icons-react';
import { useDeviceFilter } from '@/hooks/useDeviceFilter';
import { DeviceFilterDialog } from './DeviceFilterChromeAction';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { EmbedUsageModal } from './EmbedUsageModal';

const menuItemClass = 'focus:bg-secondary focus:text-secondary-foreground not-data-[variant=destructive]:focus:**:text-inherit data-highlighted:bg-secondary data-highlighted:text-secondary-foreground';

export function UsageActions({ receiptDisabled }: { receiptDisabled: boolean }) {
  const deviceFilter = useDeviceFilter();
  const [embedOpen, setEmbedOpen] = useState(false);
  return (
    <div role="group" aria-label="用量操作" className="flex shrink-0 items-center justify-end gap-1.5">
      <UsageToolbarAction
        disabled={receiptDisabled}
        aria-label="打印小票"
        onClick={() => void shareCurrentPage()}
      >
        <IconPrinter size={16} aria-hidden="true" />
        <span className="hidden sm:inline">打印小票</span>
      </UsageToolbarAction>
      <UsageToolbarAction aria-label="用量卡片" className="px-2 sm:px-2" onClick={() => setEmbedOpen(true)}>
        <IconCards size={16} aria-hidden="true" />
      </UsageToolbarAction>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger aria-label="更多用量操作" render={<UsageToolbarAction className="size-8 p-0 sm:px-0" />}>
          <IconDotsVertical size={16} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem className={menuItemClass} onClick={deviceFilter.openModal}>
            <IconDevices aria-hidden="true" />
            设备管理
            {deviceFilter.activeCount > 0 && <span className="ml-auto text-xs text-muted">{deviceFilter.activeCount}</span>}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeviceFilterDialog filter={deviceFilter} />
      <EmbedUsageModal isOpen={embedOpen} onOpenChange={setEmbedOpen} />
    </div>
  );
}

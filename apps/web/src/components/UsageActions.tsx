import { useState } from 'react';
import { IconBrandGithub, IconCards, IconDevices, IconShare } from '@tabler/icons-react';
import { DeviceFilterChromeAction } from '@/components/DeviceFilterChromeAction';
import { EmbedUsageModal } from '@/components/EmbedUsageModal';
import { GITHUB_REPO_URL } from '@/lib/downloads';
import { shareCurrentPage } from '@/lib/shell-events';
import { FeedbackPopoverTrigger } from './FeedbackPopoverTrigger';
import { Button, buttonVariants } from './ui/button';

const actionStyle = buttonVariants({ variant: 'outline', size: 'icon-sm', className: 'cursor-pointer' });

export function UsageActions() {
  const [embedOpen, setEmbedOpen] = useState(false);
  return (
    <div role="group" aria-label="用量操作" className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      <DeviceFilterChromeAction renderTrigger={(open, activeCount) => {
        const label = activeCount ? `筛选设备（已选 ${activeCount} 台）` : '筛选设备';
        return (
          <Button variant="outline" size="icon-sm" className="relative cursor-pointer" onClick={open}
            aria-haspopup="dialog" aria-label={label} title={label}>
            <IconDevices size={16} stroke={2} aria-hidden="true" />
            {activeCount > 0 && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />}
          </Button>
        );
      }} />
      <FeedbackPopoverTrigger iconOnly side="bottom" />
      <a aria-label="GitHub 仓库" title="GitHub 仓库" href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" className={actionStyle}>
        <IconBrandGithub size={16} stroke={2} aria-hidden="true" />
      </a>
      <Button variant="outline" size="icon-sm" className="cursor-pointer" aria-label="分享" title="分享" onClick={() => void shareCurrentPage()}>
        <IconShare size={16} stroke={2} aria-hidden="true" />
      </Button>
      <Button variant="outline" size="icon-sm" className="cursor-pointer" aria-label="用量卡片" title="用量卡片" onClick={() => setEmbedOpen(true)} aria-haspopup="dialog">
        <IconCards size={16} stroke={2} aria-hidden="true" />
      </Button>
      <EmbedUsageModal isOpen={embedOpen} onOpenChange={setEmbedOpen} />
    </div>
  );
}

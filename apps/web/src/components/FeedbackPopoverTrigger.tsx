import { Popover, PopoverTrigger, PopoverContent } from '@web/components/ui/popover';
import { Button } from './ui/button';
import { IconHeadset } from '@tabler/icons-react';

const WECHAT_QR_SRC = `${import.meta.env.BASE_URL}captain-wechat.jpg`;

export function FeedbackPopoverTrigger({
  side = 'top',
  iconOnly = false,
}: { side?: 'top' | 'bottom'; iconOnly?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger type="button"
        aria-label="微信问题反馈"
        render={iconOnly ? <Button variant="outline" size="icon-sm" className="cursor-pointer" /> : undefined}
        className={iconOnly ? undefined : 'download-ghost-button -ms-2'}
        openOnHover delay={120} closeDelay={180}
      >
        <IconHeadset aria-hidden="true" size={15} stroke={2} />
        {!iconOnly && <span>反馈</span>}
      </PopoverTrigger>
      <PopoverContent side={side} sideOffset={6} aria-label="微信反馈" className="w-48">
        <div>
          <h3 className="text-left text-sm font-medium text-foreground">
            微信反馈
          </h3>
          <div className="mt-2 aspect-square overflow-hidden rounded-lg bg-white">
            <img
              alt="Captain 的微信二维码"
              className="size-full scale-120 object-cover object-[center_62%]"
              decoding="async"
              draggable={false}
              src={WECHAT_QR_SRC}
            />
          </div>
          <p className="mt-2 text-xs leading-5 text-muted">
            微信扫码添加 Captain
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

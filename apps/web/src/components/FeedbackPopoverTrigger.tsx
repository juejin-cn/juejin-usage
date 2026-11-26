import type { ReactNode } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';
import { Button } from './ui/button';
import { IconHeadset } from '@tabler/icons-react';

const WECHAT_QR_SRC = `${import.meta.env.BASE_URL}captain-wechat.jpg`;

export function FeedbackPopoverTrigger({
  side = 'top',
  align = 'center',
  iconOnly = false,
  variant,
  label = '反馈',
  icon,
  className,
  labelClassName,
  iconClassName,
}: {
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  iconOnly?: boolean;
  variant?: 'ghost' | 'icon' | 'sidebar';
  label?: string;
  icon?: ReactNode;
  className?: string;
  labelClassName?: string;
  iconClassName?: string;
}) {
  const resolvedVariant = variant ?? (iconOnly ? 'icon' : 'ghost');
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="微信问题反馈"
        title={label}
        render={resolvedVariant === 'icon' ? <Button variant="secondary" size="icon-sm" className={cn('cursor-pointer', className)} /> : undefined}
        className={
          resolvedVariant === 'icon'
            ? undefined
            : resolvedVariant === 'sidebar'
              ? className
              : cn('download-ghost-button -ms-2', className)
        }
        openOnHover
        delay={120}
        closeDelay={180}
      >
        {icon ?? (
          <IconHeadset
            aria-hidden="true"
            size={resolvedVariant === 'sidebar' ? 18 : 15}
            stroke={resolvedVariant === 'sidebar' ? 1.8 : 2}
            className={iconClassName}
          />
        )}
        {resolvedVariant !== 'icon' && <span className={labelClassName}>{label}</span>}
      </PopoverTrigger>
      <PopoverContent side={side} align={align} sideOffset={8} aria-label="微信反馈" className="w-48">
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

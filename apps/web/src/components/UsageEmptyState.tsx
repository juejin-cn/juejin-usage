import type { ComponentProps } from 'react';
import usageEmpty from '../assets/usage-empty.png';
import { cn } from '@web/lib/utils';
import { Button } from './ui/button';

export function UsageEmptyIllustration() {
  return <img src={usageEmpty} alt="" className="aspect-square w-[clamp(112px,10vw,148px)] max-w-full object-contain" />;
}

export const emptyActionClass = 'inline-flex h-9 min-w-24 items-center justify-center rounded-sm border px-3 text-sm font-normal';

export function UsageEmptyAction({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button variant="ghost" className={cn(emptyActionClass, 'border-accent/32 bg-accent/5 text-accent enabled:hover:border-accent enabled:hover:bg-(--web-primary-soft) disabled:opacity-55', className)} {...props} />;
}

export function LeaderboardEmptyState({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <div className="flex min-h-[clamp(248px,24vw,308px)] flex-col items-center justify-center p-6 text-center">
      <UsageEmptyIllustration />
      <p role="status" className="mt-1 text-[15px]/6 font-medium">{message}</p>
      <UsageEmptyAction className="mt-5" onClick={onReload}>重新加载</UsageEmptyAction>
    </div>
  );
}

export function UsageToolbarAction({ className, ...props }: ComponentProps<typeof Button>) {
  return <UsageEmptyAction className={cn('h-8 min-w-0 shrink-0 gap-1.5 px-2.5 enabled:hover:text-accent sm:px-3', className)} {...props} />;
}

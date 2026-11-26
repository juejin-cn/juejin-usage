import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

function UsageCard({ className = '', ...props }: ComponentProps<'section'>) {
  return (
    <section
      {...props}
      className={cn(
        className,
        'min-w-0 rounded-[6px] border-0 bg-surface p-[12px]! shadow-web-card',
        '[&_[data-slot=metric-value]]:font-din [&_[data-slot=metric-value]]:text-2xl/7 [&_[data-slot=metric-value]]:font-bold',
      )}
    />
  );
}

function Header({ className = '', ...props }: ComponentProps<'div'>) {
  return <div {...props} className={`flex ${className}`} />;
}

function Title({ className = '', ...props }: ComponentProps<'h3'>) {
  return <h3 {...props} className={`text-base font-semibold ${className}`} />;
}

function Description({ className = '', ...props }: ComponentProps<'p'>) {
  return <p {...props} className={`text-sm text-muted ${className}`} />;
}

function Content(props: ComponentProps<'div'>) {
  return <div {...props} />;
}

export const Card = Object.assign(UsageCard, { Header, Title, Description, Content });

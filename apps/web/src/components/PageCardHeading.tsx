import type { ReactNode } from 'react';

export function PageCardHeading({ id, title, description, action }: {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2.5 sm:gap-3">
      <div className="min-w-0">
        <h1 id={id} className="text-xl/7 font-bold tracking-tight text-foreground sm:text-[28px]/9">{title}</h1>
        <p className="mt-1.5 text-xs/5 text-muted sm:mt-2 sm:text-sm/5">{description}</p>
      </div>
      {action}
    </div>
  );
}

import { Tabs, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import type { ReactNode } from 'react';

interface SegmentedProps<Value extends string> {
  label: string;
  options: readonly { id: Value; label: ReactNode }[];
  value: Value;
  onChange: (value: Value) => void;
  disabled?: boolean;
}

export function Segmented<Value extends string>({
  label, options, value, onChange, disabled,
}: SegmentedProps<Value>) {
  return (
    <Tabs
      className="w-fit min-w-0 max-w-full overflow-x-auto"
      value={value}
      onValueChange={(next) => {
        const option = options.find(({ id }) => id === next);
        if (option && !disabled) onChange(option.id);
      }}
    >
      <TabsList
        aria-label={label}
        className="relative flex h-8 w-max items-center rounded-[6px] bg-[#f4f4f5] p-0.5 dark:bg-surface-secondary"
      >
        {options.map((option) => (
          <TabsTrigger
            key={option.id}
            value={option.id}
            disabled={disabled}
            className="relative inline-flex h-full cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-sm font-medium whitespace-nowrap text-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50 data-active:text-foreground sm:px-3"
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

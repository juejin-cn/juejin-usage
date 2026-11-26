import { Tabs, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { cn } from '@web/lib/utils';
import type { ReactNode } from 'react';

interface SegmentedProps<Value extends string> {
  label: string;
  options: readonly { id: Value; label: ReactNode }[];
  value: Value;
  onChange: (value: Value) => void;
  disabled?: boolean;
  appearance?: 'compact' | 'pill';
}

export function Segmented<Value extends string>({
  label, options, value, onChange, disabled, appearance = 'compact',
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
        className={cn(
          'group-data-[orientation=horizontal]/tabs:h-8 p-0.5',
          appearance === 'pill'
            ? 'rounded-full border border-white/40 bg-surface/80 shadow-sm dark:border-white/15'
            : 'rounded-md bg-[#efefef] dark:bg-surface-secondary',
        )}
      >
        {options.map((option) => (
          <TabsTrigger
            key={option.id}
            value={option.id}
            disabled={disabled}
            className={appearance === 'pill' ? 'rounded-full px-2 text-xs sm:px-3 sm:text-sm' : 'px-2.5 sm:px-3'}
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

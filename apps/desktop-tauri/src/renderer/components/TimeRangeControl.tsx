import { cn } from '@/lib/utils';
import {
  TIME_RANGE_OPTIONS,
  type TimeRangeKey,
} from '@/lib/time-range';

interface TimeRangeControlProps {
  value: TimeRangeKey;
  onChange: (key: TimeRangeKey) => void;
  rangeLabel: string;
  className?: string;
}

/** BoardUI segmented control: week / month / unlimited + query window label. */
export function TimeRangeControl({
  value,
  onChange,
  rangeLabel,
  className,
}: TimeRangeControlProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2.5', className)}>
      <div
        className="inline-flex rounded-[10px] bg-surface-secondary p-0.5"
        role="group"
        aria-label="时间区间"
      >
        {TIME_RANGE_OPTIONS.map((opt) => {
          const active = value === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              className={cn(
                'rounded-[6px] px-2.5 py-1 text-sm font-medium transition-colors duration-100',
                active
                  ? 'bg-surface text-foreground shadow-xs'
                  : 'text-muted hover:text-foreground',
              )}
              aria-pressed={active}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <span className="font-mono text-xs font-medium text-muted tabular-nums">
        {rangeLabel}
      </span>
    </div>
  );
}

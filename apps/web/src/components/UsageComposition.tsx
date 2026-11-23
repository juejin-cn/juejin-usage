import type { ReactNode } from 'react';
import { formatPct, formatTokens, formatTokensExact } from '@/lib/format';
import { cn } from '@web/lib/utils';

export const COMPOSITION_COLORS = [
  '#4285f4',
  '#ab72ed',
  '#69ba99',
  '#efae50',
  '#e45b55',
  '#20a5a5',
] as const;

export const OTHER_COMPOSITION_COLOR = '#94a3b8';

export interface CompositionSegment {
  count: number;
  color: string;
}

export interface CompositionTableRow extends CompositionSegment {
  key: string;
  label: string;
  icon?: ReactNode;
  title?: string;
}

export function CompositionBar({
  total,
  segments,
  hasShares = true,
}: {
  total: number;
  segments: readonly CompositionTableRow[];
  hasShares?: boolean;
}) {
  return (
    <div aria-hidden="true" className="my-3.5 h-2.5 overflow-hidden rounded-full bg-surface-secondary">
      <div className="composition-bar flex h-full">
        {hasShares && total > 0 && segments.filter(segment => segment.count > 0).map(segment => (
          <span
            key={segment.key}
            className="min-w-[4px] border-surface not-first:border-l"
            style={{ width: `${segment.count / total * 100}%`, backgroundColor: segment.color }}
          />
        ))}
      </div>
    </div>
  );
}

export function CompositionTable({
  ariaLabel,
  categoryLabel,
  quantityLabel = '数量',
  rows,
  total,
  hasShares,
}: {
  ariaLabel: string;
  categoryLabel: string;
  quantityLabel?: string;
  rows: readonly CompositionTableRow[];
  total: number;
  hasShares: boolean;
}) {
  return (
    <table aria-label={ariaLabel} className="w-full table-fixed text-[13px]/5 tabular-nums">
      <thead className="border-b border-black/6 text-xs text-muted dark:border-white/6">
        <tr>
          <th scope="col" className="pb-1.5 text-left font-normal">{categoryLabel}</th>
          <th scope="col" className="w-16 pb-1.5 text-right font-normal">{quantityLabel}</th>
          <th scope="col" className="w-14 pb-1.5 text-right font-normal">占比</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.key}>
            <th
              scope="row"
              className={cn(
                'pr-2 text-left font-normal',
                index === 0 ? 'pt-2 pb-1' : 'py-1',
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5" title={row.title ?? row.label}>
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                {row.icon}
                <span className="truncate">{row.label}</span>
              </span>
            </th>
            <td
              className={cn(
                'whitespace-nowrap text-right text-muted',
                index === 0 ? 'pt-2 pb-1' : 'py-1',
              )}
              title={formatTokensExact(row.count)}
            >
              {formatTokens(row.count)}
            </td>
            <td
              className={cn(
                'whitespace-nowrap text-right text-foreground',
                index === 0 ? 'pt-2 pb-1' : 'py-1',
              )}
            >
              {hasShares && total > 0 ? formatPct((row.count / total) * 100) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

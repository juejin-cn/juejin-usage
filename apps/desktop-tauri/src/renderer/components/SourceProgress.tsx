import { sourceColor } from '@/lib/tokens';

interface SourceProgressProps {
  source: string;
  /** Percentage in [0, 100]. */
  pct: number;
  /** Whether the row has any data; controls the minimum visible width. */
  hasData: boolean;
}

/**
 * Horizontal progress bar whose fill takes the source's brand color.
 * Reused by AgentCard model lists, the ModelRankingPanel rows, and the
 * ActivityHeatmap tooltip breakdown.
 */
export function SourceProgress({ source, pct, hasData }: SourceProgressProps) {
  const width = `${Math.max(pct, hasData ? 0.5 : 0)}%`;
  return (
    <div className="h-1 overflow-hidden rounded-full bg-surface-tertiary">
      <div
        className="h-full rounded-full opacity-85"
        style={{ width, background: sourceColor(source) }}
      />
    </div>
  );
}

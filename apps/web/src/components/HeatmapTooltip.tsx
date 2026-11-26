import type { HeatmapTooltipRenderProps } from '@/components/ActivityHeatmap';
import { ProviderIcon } from '@/components/ProviderIcon';
import { formatTokens, formatTokensExact, formatUsd } from '@/lib/format';
import { sourceLabel } from '@/lib/tokens';
import {
  COMPOSITION_COLORS,
  CompositionTable,
  CompositionBar,
  OTHER_COMPOSITION_COLOR,
  type CompositionTableRow,
} from './UsageComposition';

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const MAX_INDIVIDUAL_MODELS = 6;

function formatDayHeading(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!Number.isFinite(date.getTime())) return day;
  return `${day} · ${WEEKDAY_LABELS[date.getUTCDay()]}`;
}

export function HeatmapTooltip({
  cell,
  heatmapColors,
  allModelEntries,
}: HeatmapTooltipRenderProps) {
  const rows: CompositionTableRow[] = [];
  let attributedTotal = 0;

  if (cell.value > 0 && allModelEntries.length > 0) {
    const collapseTail = allModelEntries.length > MAX_INDIVIDUAL_MODELS;
    const directEntries = collapseTail
      ? allModelEntries.slice(0, MAX_INDIVIDUAL_MODELS - 1)
      : allModelEntries;
    const tailEntries = collapseTail
      ? allModelEntries.slice(MAX_INDIVIDUAL_MODELS - 1)
      : [];

    for (const [index, entry] of directEntries.entries()) {
      attributedTotal += entry.val;
      rows.push({
        key: entry.key,
        label: entry.name,
        title: entry.source ? `${sourceLabel(entry.source)} · ${entry.name}` : entry.name,
        count: entry.val,
        color: COMPOSITION_COLORS[index % COMPOSITION_COLORS.length],
        icon: entry.source ? (
          <ProviderIcon className="shrink-0" provider={entry.source} size={18} />
        ) : undefined,
      });
    }

    const tailTokens = tailEntries.reduce((sum, entry) => sum + entry.val, 0);
    attributedTotal += tailTokens;
    const unattributedTokens = Math.max(0, cell.value - attributedTotal);
    const otherTokens = tailTokens + unattributedTokens;

    if (otherTokens > 0) {
      rows.push({
        key: '__other__',
        label: tailEntries.length > 0 ? `其他 (${tailEntries.length})` : '其他',
        count: otherTokens,
        color: OTHER_COMPOSITION_COLOR,
      });
    }
  }

  const shareTotal = Math.max(
    cell.value,
    rows.reduce((sum, row) => sum + row.count, 0),
  );
  const hasBreakdown = cell.value > 0 && rows.length > 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold tabular-nums">{formatDayHeading(cell.day)}</h3>
        <span
          role="img"
          aria-label={`用量强度 ${cell.level} / 4`}
          className="inline-flex shrink-0 items-center gap-px overflow-hidden rounded-full"
        >
          {[1, 2, 3, 4].map(level => (
            <span
              key={level}
              aria-hidden="true"
              className="h-1 w-2"
              style={{ backgroundColor: heatmapColors[level <= cell.level ? level : 0] }}
            />
          ))}
        </span>
      </div>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <strong
          className={
            cell.value > 0
              ? 'font-din text-3xl/9 font-bold tabular-nums'
              : 'font-din text-3xl/9 font-bold tabular-nums text-muted'
          }
          title={formatTokensExact(cell.value)}
        >
          {formatTokens(cell.value)}
        </strong>
        <span className="text-sm text-muted">总 Token</span>
        {cell.costUsd != null && cell.costUsd > 0 && (
          <span className="ml-auto font-din text-sm font-semibold text-muted tabular-nums">
            {formatUsd(cell.costUsd)}
          </span>
        )}
      </p>

      {hasBreakdown && (
        <>
          <CompositionBar total={shareTotal} segments={rows} hasShares={shareTotal > 0} />
          <CompositionTable
            roomy
            ariaLabel="当日模型 Token 构成"
            categoryLabel="模型"
            rows={rows}
            total={shareTotal}
            hasShares={shareTotal > 0}
          />
        </>
      )}
    </div>
  );
}

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Card } from '@heroui/react';
import type { SourceUsageRow } from '@/lib/api';
import { formatPct, formatTokens, formatUsd } from '@/lib/format';
import { sourceColor, sourceLabel, TOOLTIP_SHADOW } from '@/lib/tokens';
import { cn } from '@/lib/utils';
import { ProviderIcon } from '@/components/ProviderIcon';
import { SourceProgress } from '@/components/SourceProgress';

interface AgentShareCardProps {
  rows: SourceUsageRow[];
  selectedSource: string | null;
  selectedRow: SourceUsageRow | null;
  onSelectSource: (source: string) => void;
}

/**
 * BoardUI-aligned Agent share widget.
 * One white card → thin share bar → nested metric wells → secondary well for models.
 * Depth via gray nesting (card → muted well), not nested Cards.
 */
export function AgentShareCard({
  rows,
  selectedSource,
  selectedRow,
  onSelectSource,
}: AgentShareCardProps) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>按 Agent</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <p className="text-sm font-medium text-muted">
            暂无数据。使用 Claude Code 对话后运行同步。
          </p>
        ) : (
          <>
            <SourceStackBar rows={rows} />

            <div
              className="grid gap-2.5"
              style={{
                gridTemplateColumns: `repeat(${Math.min(rows.length, 3)}, minmax(0, 1fr))`,
              }}
            >
              {rows.map((row) => (
                <AgentMetric
                  key={row.source}
                  row={row}
                  selected={row.source === selectedSource}
                  onSelect={() => onSelectSource(row.source)}
                />
              ))}
            </div>

            {selectedRow && <ModelBreakdownWell row={selectedRow} />}
          </>
        )}
      </Card.Content>
    </Card>
  );
}

function SourceStackBar({ rows }: { rows: SourceUsageRow[] }) {
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  return (
    <div
      className="relative"
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseLeave={() => setTooltipPos(null)}
    >
      <div className="flex h-1.5 cursor-default overflow-hidden rounded-full bg-[#ebebeb] dark:bg-[#262626]">
        {rows.map((row) => (
          <div
            key={row.source}
            style={{
              flex: row.pct > 0 ? row.pct : 0,
              minWidth: row.pct > 0 ? 4 : 0,
              background: sourceColor(row.source),
            }}
          />
        ))}
      </div>
      {tooltipPos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999]"
            style={{ left: tooltipPos.x, top: tooltipPos.y }}
          >
            <div
              className="rounded-[10px] border border-border bg-overlay px-3 py-2.5 text-sm font-medium text-overlay-foreground"
              style={{
                position: 'absolute',
                left: 0,
                bottom: 10,
                transform: 'translateX(-50%)',
                boxShadow: TOOLTIP_SHADOW,
                minWidth: 168,
              }}
            >
              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <li
                    key={row.source}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ background: sourceColor(row.source) }}
                      />
                      <ProviderIcon provider={row.source} size={14} />
                      <span className="truncate text-xs font-medium tracking-[0.15px] text-foreground">
                        {sourceLabel(row.source)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-muted">
                      {formatPct(row.pct)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function AgentMetric({
  row,
  selected,
  onSelect,
}: {
  row: SourceUsageRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const modelCount = row.models.filter((m) => m.tokens > 0).length;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected}
      className={cn(
        'rounded-[10px] border px-3 py-2.5 text-left transition-colors duration-150',
        selected
          ? 'border-accent bg-surface shadow-[var(--shadow-card)] ring-2 ring-accent/25'
          : 'border-border bg-surface-secondary shadow-none hover:bg-surface-tertiary',
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <ProviderIcon provider={row.source} size={16} />
        <span className="text-xs font-medium tracking-[0.15px] text-muted">
          {sourceLabel(row.source)}
        </span>
      </div>
      <div className="text-2xl font-medium leading-[34px] tracking-normal text-foreground">
        {formatPct(row.pct)}
      </div>
      <div className="mt-0.5 text-xs font-medium text-muted">
        {modelCount} 个模型
      </div>
    </button>
  );
}

function ModelBreakdownWell({ row }: { row: SourceUsageRow }) {
  const models = row.models.filter((model) => model.tokens > 0);

  return (
    <div className="rounded-[10px] bg-surface-secondary px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderIcon provider={row.source} size={16} />
          <span className="truncate text-sm font-medium text-foreground">
            {sourceLabel(row.source)}
          </span>
        </div>
        <span className="shrink-0 text-xs font-medium text-muted">
          {formatTokens(row.tokens)} · {formatUsd(row.costUsd)}
        </span>
      </div>

      {models.length === 0 ? (
        <p className="text-sm font-medium text-muted">暂无模型用量</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {models.map((model) => (
            <li key={model.model}>
              <div className="mb-1.5 flex items-baseline justify-between gap-4">
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                  title={model.model}
                >
                  {model.model}
                </span>
                <span className="whitespace-nowrap text-xs font-medium text-muted">
                  {formatTokens(model.tokens)} · {formatUsd(model.costUsd)} ·{' '}
                  {formatPct(model.pct)}
                </span>
              </div>
              <SourceProgress source={row.source} pct={model.pct} hasData />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

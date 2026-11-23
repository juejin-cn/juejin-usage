import { Popover, PopoverTrigger, PopoverContent } from '@web/components/ui/popover';
import { IconHelpCircle } from '@tabler/icons-react';
import type { DashboardUsageSummary } from '@/lib/dashboard-mock-data';
import { formatTokens, formatTokensExact } from '@/lib/format';
import {
  COMPOSITION_COLORS,
  CompositionBar,
  CompositionTable,
  OTHER_COMPOSITION_COLOR,
  type CompositionTableRow,
} from './UsageComposition';

function TokenComposition({ summary }: { summary: DashboardUsageSummary }) {
  const { totalTokens, inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens } = summary;
  const knownTokens = inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens;
  const parts: CompositionTableRow[] = [
    { key: 'input', label: '输入', count: inputTokens, color: COMPOSITION_COLORS[0] },
    { key: 'output', label: '输出', count: outputTokens, color: COMPOSITION_COLORS[1] },
    { key: 'cacheRead', label: '缓存读', count: cachedInputTokens, color: COMPOSITION_COLORS[2] },
    { key: 'cacheWrite', label: '缓存写', count: cacheCreationInputTokens, color: COMPOSITION_COLORS[3] },
    { key: 'other', label: '其他', count: Math.max(0, totalTokens - knownTokens), color: OTHER_COMPOSITION_COLOR },
  ];
  const hasShares = totalTokens > 0 && knownTokens <= totalTokens;

  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <strong className="font-din text-3xl/9 font-bold tabular-nums" title={formatTokensExact(totalTokens)}>{formatTokens(totalTokens)}</strong>
        <span className="text-xs text-muted">总 Token</span>
      </p>
      <CompositionBar total={totalTokens} segments={parts} hasShares={hasShares} />
      <CompositionTable
        ariaLabel="Token 构成明细"
        categoryLabel="类别"
        rows={parts}
        total={totalTokens}
        hasShares={hasShares}
      />
      <p className="mt-3 text-xs leading-5 text-muted">
        {knownTokens > totalTokens ? '上报分项之和超过总量，暂无可用占比。' : '总 Token = 输入 + 输出 + 缓存读 + 缓存写 + 其他'}
      </p>
    </>
  );
}

export function TokenDetails({ summary }: { summary: DashboardUsageSummary }) {
  return (
    <Popover>
      <PopoverTrigger type="button" aria-label="查看总 Token 计算明细" className="inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-full text-muted transition-colors hover:bg-surface-secondary hover:text-foreground aria-expanded:bg-surface-secondary aria-expanded:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
        <IconHelpCircle aria-hidden="true" className="size-4" stroke={1.75} />
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="总 Token 计算明细">
        <TokenComposition summary={summary} />
      </PopoverContent>
    </Popover>
  );
}

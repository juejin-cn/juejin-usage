import { PageCardHeading } from '@web/components/PageCardHeading';
import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import { ModelChange, ModelTrend } from '@/components/ModelRankTrend';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useModelLeaderboardData } from '@/hooks/useModelLeaderboardData';
import type { LeaderboardMetric } from '@/lib/api';
import { formatPct, formatTokens } from '@/lib/format';
import { isRankRange, type RankRange } from '@/lib/leaderboard';
import { getModelProvider } from '@/lib/model-provider';
import { Segmented } from '@web/components/Segmented';
import { LeaderboardPodium, UserLeaderboardPodiumSkeleton } from '@web/components/UserLeaderboardPodium';
import { UserLeaderboardTableSkeleton } from '@web/components/UserLeaderboardTable';
import { leaderboardSurface, rankBadgeClass, rankNumberTone, RANGE_OPTIONS } from '@web/components/leaderboard-styles';
import { Button } from '@web/components/ui/button';
import { LeaderboardEmptyState } from '@web/components/UsageEmptyState';
import { formatRankUsd } from '@web/lib/rank-view';
import { cn } from '@web/lib/utils';

export const Route = createFileRoute('/model-rank')({ component: ModelRankPage });

const columns = 'grid grid-cols-[1.75rem_minmax(0,1fr)_4.75rem_3.75rem] items-center gap-1.5 px-3 sm:gap-2 sm:px-5 @3xl:grid-cols-[3rem_minmax(0,1fr)_4rem_6rem_5rem_6.5rem_4rem]';
const metrics = [{ id: 'tokens', label: '按 Token' }, { id: 'cost', label: '按消费' }] as const;

function ModelRankPage() {
  const [range, setRange] = useLocalStorage<RankRange>('tud.modelRankRange', 'month', isRankRange);
  const [metric, setMetric] = useState<LeaderboardMetric>('tokens');
  const { data, error, loading, refreshing, reload } = useModelLeaderboardData(range, {});
  const busy = loading || refreshing;
  const rows = data?.boards[metric].rows ?? [];

  return (
    <section className={leaderboardSurface} aria-labelledby="model-rank-title" aria-busy={busy}>
      <header className="web-card-header space-y-4 px-4 py-4 sm:px-5 sm:py-5">
        <PageCardHeading id="model-rank-title" title="模型排行" description="按 Token 用量或消费金额，查看各模型的排名与变化。" />
        <div role="group" aria-label="模型排行筛选" className="flex flex-wrap items-center justify-between gap-2">
          <Segmented label="时间范围" options={RANGE_OPTIONS} value={range} onChange={setRange} />
          <Segmented label="排行指标" options={metrics} value={metric} onChange={setMetric} />
        </div>
      </header>
      {error && !busy && (data ? (
        <div className="mx-4 flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-secondary px-3 py-2 sm:mx-5">
          <p role="status" className="text-sm text-muted">刷新失败，当前显示上次加载的排行。</p>
          <Button variant="secondary" size="sm" onClick={reload}>重试</Button>
        </div>
      ) : (
        <LeaderboardEmptyState message="模型排行暂时无法加载" onReload={reload} />
      ))}
      {busy && <><UserLeaderboardPodiumSkeleton /><UserLeaderboardTableSkeleton label="模型排行榜加载中" /></>}
      {!busy && data && (rows.length ? <div>
        <LeaderboardPodium metric={metric} entries={rows.slice(0, 3).map(row => ({
          ...row, id: row.model, displayName: row.model,
          avatar: className => <span className={cn('grid place-items-center rounded-full bg-surface', className)}>
            <ModelProviderIcon provider={getModelProvider(row.model)} fallbackText={row.model} size={row.rank === 1 ? 40 : 30} />
          </span>,
        }))} />
        <div className={cn(columns, 'h-11 bg-[#fafafa] text-sm text-muted dark:bg-white/[0.025]')}>
          <span className="text-center">#</span><span>模型</span><span className="hidden text-right @3xl:block">占总量</span>
          <button className={cn('text-right', metric === 'cost' && 'text-primary')} onClick={() => setMetric('cost')}>总费用</button>
          <button className={cn('text-right', metric === 'tokens' && 'text-primary')} onClick={() => setMetric('tokens')}>Token</button>
          <span className="hidden text-center @3xl:block">趋势</span><span className="hidden text-right @3xl:block">环比</span>
        </div>
        <ol className="divide-y divide-black/6 bg-white dark:divide-white/8 dark:bg-surface">
          {rows.map(row => <li key={row.model} className={cn(columns, 'py-3 text-sm tabular-nums sm:py-3.5 hover:bg-surface-secondary')}>
            <span className={cn('text-center font-code', rankNumberTone(row.rank), rankBadgeClass(row.rank))}>{row.rank}</span>
            <span className="flex min-w-0 items-center gap-2"><ModelProviderIcon provider={getModelProvider(row.model)} fallbackText={row.model} size={22} />
              <span className="truncate" title={row.model}>{row.model}</span>
            </span>
            <span className="hidden text-right text-muted @3xl:block">{formatPct(row.share)}</span>
            <span className={cn('text-right font-din', metric === 'cost' && 'text-primary')}>{formatRankUsd(row.costUsd)}</span>
            <span className={cn('text-right font-din', metric === 'tokens' && 'text-primary')} title={row.tokens.toLocaleString()}>{formatTokens(row.tokens)}</span>
            <div className="col-span-full flex flex-wrap items-center justify-between gap-2 pl-9 text-xs @3xl:contents">
              <span className="text-muted @3xl:hidden">占比 {formatPct(row.share)}</span>
              <div className="flex items-center gap-3 @3xl:contents">
                <ModelTrend row={row} metric={metric} /><span className="text-right"><ModelChange row={row} /></span>
              </div>
            </div>
          </li>)}
        </ol>
      </div> : <LeaderboardEmptyState message="当前范围暂无模型排行数据" onReload={reload} />)}
    </section>
  );
}

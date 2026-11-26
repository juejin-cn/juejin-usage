import { useState } from 'react';
import { Button } from '@heroui/react';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import { RankTitleDecor } from '@/components/RankDecorations';
import { RankGithubButton, RankRangeControl } from '@/components/RankFilter';
import { RANK_LIST_CARD, RankNumber, RankUsageMetrics } from '@/components/RankListParts';
import { RankMetricSwitch } from '@/components/RankMetricSwitch';
import { StatusBanner } from '@/components/StatusBanner';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useModelLeaderboardData } from '@/hooks/useModelLeaderboardData';
import type { LeaderboardMetric, ModelLeaderboardRow } from '@/lib/api';
import { formatPct } from '@/lib/format';
import { isRankRange, type RankRange } from '@/lib/leaderboard';
import { getModelProvider } from '@/lib/model-provider';
import { cn } from '@/lib/utils';

import { ModelChange, ModelTrend } from '@/components/ModelRankTrend';

function ModelListRow({ row, metric, lifetime }: { row: ModelLeaderboardRow; metric: LeaderboardMetric; lifetime: boolean }) {
  const provider = getModelProvider(row.model);

  return (
    <li className="min-w-0 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.04] [content-visibility:auto] [contain-intrinsic-size:auto_56px]">
      <div className="flex min-w-0 items-center gap-2 px-4 py-3 sm:gap-5 sm:px-6 sm:py-4">
        <RankNumber rank={row.rank} />
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border bg-white dark:bg-surface sm:size-9">
            <ModelProviderIcon fallbackText={row.model} provider={provider} size={20} />
          </span>
          <span className="min-w-0 truncate text-sm font-semibold text-foreground sm:text-[15px]" title={row.model}>
            {row.model}
          </span>
        </div>
        <span className="hidden w-14 shrink-0 text-right text-xs tabular-nums text-muted lg:block">{formatPct(row.share)}</span>
        <RankUsageMetrics costUsd={row.costUsd} tokens={row.tokens} />
        {!lifetime && <span className="hidden w-26 shrink-0 lg:block"><ModelTrend row={row} metric={metric} /></span>}
        {!lifetime && <span className="hidden w-16 shrink-0 text-right text-xs lg:block"><ModelChange row={row} /></span>}
      </div>
      <div className="flex items-center justify-end gap-3 px-4 pb-3 text-xs lg:hidden">
        <span className="text-muted">占比 {formatPct(row.share)}</span>
        {!lifetime && <ModelTrend row={row} metric={metric} />}
        {!lifetime && <span className="min-w-12 text-right"><ModelChange row={row} /></span>}
      </div>
    </li>
  );
}

function ModelListSkeleton() {
  return (
    <div aria-label="模型排行榜加载中" className={cn(RANK_LIST_CARD, 'min-w-0 overflow-hidden animate-pulse')}>
      <div className="flex items-center gap-2 px-4 py-2.5 sm:gap-5 sm:px-6 sm:py-3">
        <span className="w-10 shrink-0 sm:w-12" />
        <span className="h-3 w-8 rounded-md bg-surface-secondary" />
        <span className="ml-auto h-3 w-12 rounded-md bg-surface-secondary" />
        <span className="h-3 w-12 rounded-md bg-surface-secondary" />
      </div>
      {Array.from({ length: 7 }, (_, index) => (
        <div className="flex items-center gap-2 px-4 py-3 sm:gap-5 sm:px-6 sm:py-4" key={index}>
          <span className="h-6 w-10 shrink-0 rounded-md bg-surface-secondary sm:w-12" />
          <span className="size-8 shrink-0 rounded-xl border border-border bg-surface-secondary sm:size-9" />
          <span className="h-3 w-32 flex-1 rounded-md bg-surface-secondary sm:max-w-48" />
          <span className="h-3 w-12 rounded-md bg-surface-secondary sm:w-24" />
          <span className="h-3 w-12 rounded-md bg-surface-secondary sm:w-20" />
        </div>
      ))}
    </div>
  );
}

export function ModelRankPage() {
  const [range, setRange] = useLocalStorage<RankRange>('tud.modelRankRange', 'month', isRankRange);
  const [metric, setMetric] = useState<LeaderboardMetric>('tokens');
  const { data, error, loading, refreshing, reload } = useModelLeaderboardData(range, {});
  const rows = data?.boards[metric].rows ?? [];

  return (
    <div aria-busy={loading || refreshing} className="relative flex w-full min-w-0 flex-col">
      <div aria-label="模型排行榜筛选" className="mb-4 flex w-full min-w-0 select-none items-center gap-1.5 sm:gap-2">
        <RankRangeControl value={range} onChange={setRange} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <RankGithubButton />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex w-full min-w-0 flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            <RankTitleDecor>模型排行榜</RankTitleDecor>
          </h1>
          <RankMetricSwitch costLabel="按金额" metric={metric} onMetricChange={setMetric} />
        </div>

        {error && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <StatusBanner
                description={data ? `${error}。当前显示上次成功加载的数据。` : error}
                title={data ? '模型排行刷新失败' : '模型排行加载失败'}
                tone={data ? 'warn' : 'error'}
              />
            </div>
            <Button onPress={reload} variant="outline">重试</Button>
          </div>
        )}

        {loading && !data ? <ModelListSkeleton /> : data && (
          <div className={cn(RANK_LIST_CARD, 'min-w-0 transition-opacity duration-150', refreshing && 'opacity-60')}>
            {rows.length === 0 ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm">当前范围暂无模型排行数据</p>
                <p className="text-xs text-muted">试试其他时间范围</p>
              </div>
            ) : (
              <>
                <div aria-hidden className="flex items-center gap-2 px-4 py-2.5 text-[11px] text-muted sm:gap-5 sm:px-6 sm:py-3 sm:text-xs">
                  <span className="w-10 shrink-0 sm:w-12" />
                  <span className="min-w-0 flex-1">模型</span>
                  <span className="hidden w-14 shrink-0 text-right lg:block">占总量</span>
                  <div className="flex shrink-0 items-center gap-2 sm:gap-8">
                    <span className="w-[3.25rem] text-right sm:w-24">总 Token</span>
                    <span className="w-[3.25rem] text-right sm:w-20">总金额</span>
                  </div>
                  {range !== 'all' && <span className="hidden w-26 shrink-0 text-center lg:block">趋势</span>}
                  {range !== 'all' && <span className="hidden w-16 shrink-0 text-right lg:block">环比</span>}
                </div>
                <ol className="min-w-0">
                  {rows.map((row) => <ModelListRow key={row.model} metric={metric} row={row} lifetime={range === 'all'} />)}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

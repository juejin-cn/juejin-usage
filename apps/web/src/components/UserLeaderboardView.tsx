import { UsageEmptyAction } from '@web/components/UsageEmptyState';
import { PageCardHeading } from '@web/components/PageCardHeading';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconCheck,
  IconChevronDown,
  IconBox,
  IconLayoutGrid,
  IconEyeOff,
  IconSearch,
  IconShare,
  IconX,
} from '@tabler/icons-react';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import { ProviderIcon } from '@/components/ProviderIcon';
import { RankShareModal } from '@/components/RankShareModal';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { useLeaderboardData } from '@/hooks/useLeaderboardData';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import {
  fetchLeaderboardPreference,
  isCliBackend,
  updateLeaderboardPreference,
  type LeaderboardMetric,
} from '@/lib/api';
import { isMockDataEnabled } from '@/lib/env';
import {
  groupRankModelsByVendor,
  isRankRange,
  resolveLeaderboardCurrentUser,
  uniqueRankModelOptions,
  type RankModelVendorKey,
  type RankRange,
} from '@/lib/leaderboard';
import { DATA_SYNCED_EVENT } from '@/lib/shell-events';
import { Button } from '@web/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@web/components/ui/combobox';
import { Input } from '@web/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Segmented } from '@web/components/Segmented';
import { formatRankBadge } from '@web/lib/rank-view';
import { cn } from '@web/lib/utils';
import {
  UserLeaderboardPodium,
  UserLeaderboardPodiumSkeleton,
} from './UserLeaderboardPodium';
import {
  UserLeaderboardTable,
  UserLeaderboardTableSkeleton,
} from './UserLeaderboardTable';

import { leaderboardSurface, RANGE_OPTIONS } from './leaderboard-styles';


function ToolFilterSelect({
  tools,
  value,
  onChange,
}: {
  tools: readonly { key: string; displayName: string }[];
  value: string;
  onChange: (tool: string) => void;
}) {
  const items = useMemo(
    () => [{ key: '', displayName: '全部工具' }, ...tools],
    [tools],
  );
  const selected = items.find((item) => item.key === value) ?? items[0]!;

  return (
    <Combobox
      items={items}
      value={selected}
      onValueChange={(option) => onChange(option?.key ?? '')}
      itemToStringLabel={(option) => option.displayName}
      isItemEqualToValue={(a, b) => a.key === b.key}
    >
      <div className="inline-flex h-8 min-w-0 items-center rounded-md bg-secondary">
        <ComboboxTrigger
          render={<Button variant="secondary" size="sm" />}
          aria-label={`工具筛选：${selected.displayName}`}
          className={cn(
            'min-w-0 flex-1 gap-1.5',
            value && 'rounded-r-none border-r-0',
          )}
        >
          {selected.key && <ProviderIcon provider={selected.key} size={14} />}
          <span className="max-w-32 truncate">{selected.displayName}</span>
          {!value && (
            <IconChevronDown aria-hidden="true" className="size-3.5 text-muted" />
          )}
        </ComboboxTrigger>
        {value && (
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="清除工具筛选"
            className="rounded-l-none border-l-0"
            onClick={() => onChange('')}
          >
            <IconX aria-hidden="true" size={14} />
          </Button>
        )}
      </div>
      <ComboboxContent className="flex w-60 min-w-0 max-w-[min(var(--available-width),calc(100vw-1rem))] flex-col">
        <div className="relative m-2 shrink-0">
          <ComboboxInput
            render={<Input />}
            aria-label="搜索工具"
            placeholder="搜索工具"
            className="h-8 pr-8"
          />
          <IconSearch
            aria-hidden="true"
            className="pointer-events-none absolute right-2 top-2 size-4 text-muted"
          />
        </div>
        <ComboboxEmpty>没有匹配的工具</ComboboxEmpty>
        <ComboboxList
          aria-label="工具筛选列表"
          className="min-h-0 max-h-64 px-2 pb-2 [scrollbar-width:thin]"
        >
          {(option: typeof selected) => (
            <ComboboxItem
              key={option.key || 'all'}
              value={option}
              showIndicator={Boolean(option.key)}
            >
              {option.key && <ProviderIcon provider={option.key} size={15} />}
              <span className="min-w-0 flex-1 truncate">{option.displayName}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function ModelCascadePopover({
  models,
  value,
  onChange,
}: {
  models: readonly string[];
  value: string;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const allGroups = useMemo(() => groupRankModelsByVendor(models), [models]);
  const groups = useMemo(
    () => groupRankModelsByVendor(models, query),
    [models, query],
  );
  const selectedGroup = allGroups.find((group) => group.models.includes(value));
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeVendor, setActiveVendor] = useState<RankModelVendorKey>('all');
  const visibleModels = useMemo(() => groups
    .filter(group => activeVendor === 'all' || group.key === activeVendor)
    .flatMap(group => group.models.map(name => ({ name, group })))
    .sort((a, b) => a.name.localeCompare(b.name)), [groups, activeVendor]);
  const label =
    selectedGroup && value ? `${selectedGroup.label} › ${value}` : '全部模型';

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setActiveVendor(selectedGroup?.key ?? 'all');
    setOpen(nextOpen);
    if (!nextOpen) setQuery('');
  };

  const selectModel = (model: string) => {
    onChange(model);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div className="inline-flex h-8 min-w-0 items-center rounded-md bg-secondary">
        <PopoverTrigger
          render={<Button variant="secondary" size="sm" />}
          aria-label={`模型筛选：${label}`}
          className={cn(
            'min-w-0 flex-1 gap-1.5',
            value && 'rounded-r-none border-r-0',
          )}
        >
          <span className="max-w-36 truncate sm:max-w-44">{label}</span>
          {!value && (
            <IconChevronDown aria-hidden="true" className="size-3.5 text-muted" />
          )}
        </PopoverTrigger>
        {value && (
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="清除模型筛选"
            className="rounded-l-none border-l-0"
            onClick={() => onChange('')}
          >
            <IconX aria-hidden="true" size={14} />
          </Button>
        )}
      </div>

      <PopoverContent
        align="start"
        sideOffset={6}
        initialFocus={searchRef}
        aria-label="模型筛选"
        className="grid h-[min(21rem,var(--available-height))] w-[min(27rem,calc(100vw-1rem))] grid-cols-[3rem_minmax(0,1fr)] gap-0 overflow-hidden p-0 ring-foreground/5"
      >
        <div role="group" aria-label="模型厂商" className="min-h-0 overflow-y-auto overscroll-contain border-r border-border/50 p-1 [scrollbar-width:thin]">
          {[{ key: 'all' as const, label: '全部厂商', icon: '' }, ...allGroups.filter(group => group.models.length)].map(group => (
            <Button
              key={group.key}
              variant="ghost"
              size="icon"
              title={group.label}
              aria-label={group.label}
              aria-pressed={group.key === activeVendor}
              onClick={() => setActiveVendor(group.key)}
              className="relative mb-1 w-full hover:bg-secondary aria-pressed:bg-secondary aria-pressed:after:absolute aria-pressed:after:right-0 aria-pressed:after:h-4 aria-pressed:after:w-0.5 aria-pressed:after:rounded-full aria-pressed:after:bg-primary"
            >
              {group.key === 'all' ? <IconLayoutGrid aria-hidden className="size-5" />
                : group.icon === 'unknown' ? <IconBox aria-hidden className="size-5" />
                : <ModelProviderIcon provider={group} size={20} />}
            </Button>
          ))}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="relative m-2">
            <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted" />
            <Input ref={searchRef} aria-label="搜索厂商或模型" placeholder="搜索厂商或模型"
              className="h-8 border-input/60 px-8 shadow-none focus-visible:border-ring/65 focus-visible:ring-2 focus-visible:ring-ring/20" value={query} onChange={event => setQuery(event.target.value)} />
            {query && (
              <Button variant="ghost" size="icon-xs" aria-label="清空搜索" className="absolute right-1 top-1"
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
                <IconX aria-hidden />
              </Button>
            )}
          </div>
          <div key={activeVendor} role="group" aria-label="模型列表" className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2 [scrollbar-width:thin]">
            {activeVendor === 'all' && !query.trim() && (
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => selectModel('')}>
                全部模型{!value && <IconCheck aria-hidden className="ml-auto" />}
              </Button>
            )}
            {visibleModels.map(({ name, group }) => (
              <Button key={name} variant="ghost" size="sm" title={name} aria-pressed={name === value}
                className="w-full justify-start gap-2 text-left font-normal hover:bg-secondary aria-pressed:bg-secondary"
                onClick={() => selectModel(name)}>
                {group.icon === 'unknown' ? <IconBox aria-hidden /> : <ModelProviderIcon provider={group} size={16} />}
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {name === value && <IconCheck aria-hidden className="shrink-0" />}
              </Button>
            ))}
            {!visibleModels.length && <p className="py-8 text-center text-sm text-muted">没有匹配的模型</p>}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function UserLeaderboardView() {
  const [range, setRange] = useLocalStorage<RankRange>(
    'tud.rankRange',
    'today',
    isRankRange,
  );
  const [tool, setTool] = useState('');
  const [model, setModel] = useState('');
  const [metric, setMetric] = useState<LeaderboardMetric>('tokens');
  const [hideFromLeaderboard, setHideFromLeaderboard] = useState(false);
  const [hideToggleSaving, setHideToggleSaving] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);

  const mockEnabled = isMockDataEnabled();
  const { data, error, loading, refreshing, reload } = useLeaderboardData(
    range,
    {
      tool: tool || undefined,
      model: model || undefined,
    },
  );
  const busy = loading || refreshing;
  const { authStatus, userId, userName, avatarLarge } = useJuejinAuth();
  const cliBackend = isCliBackend();
  const showPersonalRank = cliBackend || authStatus === 'authenticated';
  const showHideToggle = showPersonalRank && !mockEnabled;

  useEffect(() => {
    const onSynced = () => {
      void reload();
    };
    window.addEventListener(DATA_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(DATA_SYNCED_EVENT, onSynced);
  }, [reload]);

  useEffect(() => {
    if (!showHideToggle) {
      setHideFromLeaderboard(false);
      return;
    }
    let cancelled = false;
    void fetchLeaderboardPreference()
      .then((preference) => {
        if (!cancelled) setHideFromLeaderboard(preference.hideFromLeaderboard);
      })
      .catch(() => {
        if (!cancelled) setHideFromLeaderboard(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showHideToggle]);

  const filterOptions = data?.filterOptions;
  const modelOptions = useMemo(
    () => uniqueRankModelOptions(filterOptions?.models ?? [], tool),
    [filterOptions?.models, tool],
  );

  const profiles = useMemo(() => {
    const result = { ...(data?.profiles ?? {}) };
    if (userId && userName) {
      result[userId] = {
        uid: userId,
        userName,
        avatarUrl: avatarLarge,
        profileUrl: `https://juejin.cn/user/${encodeURIComponent(userId)}`,
      };
    }
    return result;
  }, [data?.profiles, userId, userName, avatarLarge]);

  const onHideFromLeaderboardChange = (hide: boolean) => {
    const previous = hideFromLeaderboard;
    setHideFromLeaderboard(hide);
    setHideToggleSaving(true);
    void updateLeaderboardPreference(hide)
      .then(() => {
        reload({ silent: true });
      })
      .catch(() => {
        setHideFromLeaderboard(previous);
      })
      .finally(() => {
        setHideToggleSaving(false);
      });
  };

  const board = data?.global[metric] ?? null;
  const tokensRankBadge =
    !hideFromLeaderboard && !loading
      ? formatRankBadge(resolveLeaderboardCurrentUser(data?.global.tokens)?.rank)
      : null;
  const costRankBadge =
    !hideFromLeaderboard && !loading
      ? formatRankBadge(resolveLeaderboardCurrentUser(data?.global.cost)?.rank)
      : null;

  const metricOptions = useMemo(
    () =>
      [
        {
          id: 'tokens' as const,
          label: (
            <span className="inline-flex items-center gap-1">
              <span>按 Token</span>
              {tokensRankBadge && (
                <span className="font-code text-xs opacity-75 tabular-nums">
                  {tokensRankBadge}
                </span>
              )}
            </span>
          ),
        },
        {
          id: 'cost' as const,
          label: (
            <span className="inline-flex items-center gap-1">
              <span>按消费</span>
              {costRankBadge && (
                <span className="font-code text-xs opacity-75 tabular-nums">
                  {costRankBadge}
                </span>
              )}
            </span>
          ),
        },
      ] as const,
    [costRankBadge, tokensRankBadge],
  );

  const toolLabel =
    filterOptions?.tools.find((item) => item.key === tool)?.displayName ??
    '全部工具';
  const modelLabel = model || '全部模型';

  return (
    <section
      aria-busy={busy}
      aria-labelledby="rank-users-heading"
      className={cn(leaderboardSurface, 'user-rank')}
    >
      <header className="web-card-header px-4 py-4 sm:px-5 sm:py-5">
        <PageCardHeading
          id="rank-users-heading"
          title="用户排行"
          description="看看社区用户的 Token 用量和消费排名。"
          action={
            <UsageEmptyAction
              className="min-w-0 shrink-0 gap-1 px-2.5 enabled:hover:text-accent"
              aria-label="分享排行榜"
              onClick={() => setIsShareOpen(true)}
            >
              <IconShare size={16} aria-hidden="true" />
              分享
            </UsageEmptyAction>
          }
        />
      </header>

      {(data != null || error == null) && (busy ? (
        <UserLeaderboardPodiumSkeleton />
      ) : (
        <UserLeaderboardPodium rows={board?.rows ?? []} metric={metric} profiles={profiles} />
      ))}

      <div
        role="group"
        aria-label="排行榜筛选"
        className="mx-4 mb-3 flex min-w-0 flex-wrap items-center gap-2 py-1 sm:mx-5 @3xl:flex-nowrap @3xl:overflow-x-auto @3xl:overscroll-x-contain [scrollbar-width:thin] [&>*]:shrink-0"
      >
        <Segmented
          label="时间范围"
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
        />
        <div className="flex flex-wrap items-center gap-2 @3xl:ml-auto @3xl:flex-nowrap">
          <ToolFilterSelect
            tools={filterOptions?.tools ?? []}
            value={tool}
            onChange={(nextTool) => {
              setTool(nextTool);
              setModel('');
            }}
          />
          <ModelCascadePopover
            models={modelOptions.map((item) => item.model)}
            value={model}
            onChange={setModel}
          />
          <Segmented
            label="排行指标"
            options={metricOptions}
            value={metric}
            onChange={setMetric}
          />
          {showHideToggle && (
            <Button
              variant="secondary"
              size="sm"
              role="switch"
              aria-checked={hideFromLeaderboard}
              disabled={hideToggleSaving}
              onClick={() => onHideFromLeaderboardChange(!hideFromLeaderboard)}
              className="aria-checked:bg-primary/10 aria-checked:text-primary"
            >
              <IconEyeOff aria-hidden="true" size={16} />
              隐藏自己
            </Button>
          )}
        </div>
      </div>

      {error != null && data == null ? (
        <div
          role="status"
          className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <p className="text-sm text-foreground">排行榜加载失败</p>
          <p className="text-xs text-muted">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1 cursor-pointer"
            onClick={() => reload()}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          {error != null && data != null && (
            <div
              role="status"
              className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3.5 py-2.5 text-xs text-amber-800 sm:mx-5 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300"
            >
              <span className="min-w-0 flex-1">
                排行榜刷新失败：{error}。当前显示上次成功加载的数据。
              </span>
              <Button
                variant="outline"
                size="xs"
                className="shrink-0 cursor-pointer"
                onClick={() => reload()}
              >
                重试
              </Button>
            </div>
          )}

          {busy ? (
            <UserLeaderboardTableSkeleton />
          ) : (
            <UserLeaderboardTable
              onReload={reload}
              board={board}
              hideFromLeaderboard={hideFromLeaderboard}
              metric={metric}
              onMetricChange={setMetric}
              profiles={profiles}
            />
          )}
        </>
      )}

      <RankShareModal
        board={board}
        hideFromLeaderboard={hideFromLeaderboard}
        isSignedIn={showPersonalRank}
        loading={busy}
        metric={metric}
        modelLabel={modelLabel}
        onOpenChange={setIsShareOpen}
        open={isShareOpen}
        profiles={profiles}
        toolLabel={toolLabel}
      />
    </section>
  );
}

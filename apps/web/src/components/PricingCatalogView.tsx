import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  IconArrowsSort,
  IconCheck,
  IconCirclePlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import { fetchPricingCatalog, type PricingCatalogResponse } from '@/lib/api';
import { filterDirectPricingCatalog } from '@/lib/pricing-catalog';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import {
  buildProviderOptions,
  DEFAULT_PRICING_VIEW_SORT,
  filterAndSortPricingRows,
  PRICING_SORT_OPTIONS,
  type PricingProviderOption,
  type PricingViewSortKey,
} from '@web/lib/pricing-view';
import { cn } from '@web/lib/utils';
import { PricingModelCard } from './PricingModelCard';

const headerLayout = 'flex flex-col gap-3 border-b border-black/6 px-4 py-3.5 sm:px-5 @4xl:flex-row @4xl:items-center @4xl:justify-between dark:border-white/6';
const filterLayout = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @lg:grid-cols-[auto_auto_minmax(0,1fr)] @4xl:grid-cols-[auto_auto_13rem]';
const searchLayout = 'col-span-full @lg:col-span-1';

const gridWrapperClass = '@container overflow-hidden';
const gridContainerClass =
  '-mr-px -mb-px grid grid-cols-1 @lg:grid-cols-2 @3xl:grid-cols-3';
const gridCellBorder = 'border-r border-b border-black/6 dark:border-white/6';

function PricingSkeleton() {
  return (
    <section className="@container" aria-label="模型价格加载中" role="status">
      <span className="sr-only">正在加载模型价格</span>
      <div className={cn(headerLayout, 'motion-safe:animate-pulse')}>
        <div className="flex items-baseline gap-2.5">
          <div className="h-6 w-20 rounded bg-surface-secondary" />
          <div className="h-4 w-16 rounded bg-surface-secondary" />
        </div>
        <div className={filterLayout}>
          <div className="h-8 @lg:w-24 rounded-md bg-surface-secondary" />
          <div className="h-8 w-36 rounded-md bg-surface-secondary" />
          <div className={cn(searchLayout, 'h-8 rounded-md bg-surface-secondary')} />
        </div>
      </div>
      <div className={gridWrapperClass}>
        <div className={cn(gridContainerClass, 'motion-safe:animate-pulse')}>
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className={cn('p-4', gridCellBorder)}>
              <div className="flex items-center gap-3">
                <div className="size-8 shrink-0 rounded-full bg-surface-secondary" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-4 w-28 rounded bg-surface-secondary" />
                  <div className="h-3 w-36 rounded bg-surface-secondary" />
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
                <div className="h-4 w-24 rounded bg-surface-secondary" />
                <div className="h-4 w-24 rounded bg-surface-secondary" />
                <div className="h-4 w-20 rounded bg-surface-secondary" />
                <div className="h-4 w-20 rounded bg-surface-secondary" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProviderFilterPopover({
  options,
  totalCount,
  value,
  onChange,
}: {
  options: readonly PricingProviderOption[];
  totalCount: number;
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((provider) => provider.key === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'inline-flex h-8 items-center rounded-md border transition-colors',
          selected
            ? 'border-accent/40 bg-(--web-primary-soft) text-accent'
            : 'border-border bg-transparent text-foreground',
        )}
      >
          <PopoverTrigger
            type="button"
            aria-label={selected ? `供应商筛选：${selected.label}` : '按供应商筛选'}
            className={cn(
              'inline-flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
              selected ? 'rounded-r-none pr-1.5' : 'hover:bg-surface-secondary',
            )}
          >
          {selected ? (
            <>
              <ModelProviderIcon provider={selected} size={14} />
              <span className="max-w-28 truncate">{selected.label}</span>
            </>
          ) : (
            <>
              <IconCirclePlus size={14} stroke={1.8} className="text-muted" aria-hidden="true" />
              <span>供应商</span>
            </>
          )}
        </PopoverTrigger>
        {selected && (
          <button
            type="button"
            aria-label="清除供应商筛选"
            onClick={() => onChange('')}
            className="inline-flex h-full cursor-pointer items-center rounded-r-md pr-2 pl-1 text-accent/70 transition-colors outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
          >
            <IconX size={13} stroke={2} aria-hidden="true" />
          </button>
        )}
      </div>
      <PopoverContent align="end" className="w-56 p-1.5" aria-label="供应商筛选列表">
        <div className="max-h-72 overflow-y-auto">
          <button
            type="button"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-secondary',
              !value ? 'font-medium text-accent' : 'text-foreground',
            )}
          >
            <span className="flex-1 truncate">全部供应商</span>
            <span className="text-xs text-muted tabular-nums">{totalCount}</span>
            {!value && <IconCheck size={14} className="shrink-0 text-accent" aria-hidden="true" />}
          </button>
          <div className="my-1 h-px bg-black/6 dark:bg-white/6" />
          {options.map((provider) => {
            const active = provider.key === value;
            return (
              <button
                key={provider.key}
                type="button"
                onClick={() => {
                  onChange(active ? '' : provider.key);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-secondary',
                  active ? 'font-medium text-accent' : 'text-foreground',
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <ModelProviderIcon provider={provider} size={14} />
                </span>
                <span className="min-w-0 flex-1 truncate">{provider.label}</span>
                <span className="text-xs text-muted tabular-nums">{provider.count}</span>
                {active && <IconCheck size={14} className="shrink-0 text-accent" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SortDropdown({
  value,
  onChange,
}: {
  value: PricingViewSortKey;
  onChange: (next: PricingViewSortKey) => void;
}) {
  const activeOption =
    PRICING_SORT_OPTIONS.find((option) => option.key === value) ?? PRICING_SORT_OPTIONS[0];

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        type="button"
        aria-label={`排序方式：${activeOption.label}`}
        className="inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-transparent px-2.5 text-sm transition-colors outline-none hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-accent"
      >
        <IconArrowsSort size={14} stroke={1.8} className="text-muted" aria-hidden="true" />
        <span className="text-muted">排序</span>
        <span aria-hidden="true" className="h-3.5 w-px bg-black/10 dark:bg-white/15" />
        <span className="font-medium text-foreground">{activeOption.shortLabel}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-48 ring-1 ring-black/6 dark:ring-white/10"
        aria-label="排序选项"
      >
        {PRICING_SORT_OPTIONS.map((option) => {
          const active = option.key === value;
          return (
            <DropdownMenuItem
              key={option.key}
              onClick={() => onChange(option.key)}
              className={cn(
                'cursor-pointer justify-between gap-2 text-sm',
                active && 'font-medium text-accent',
              )}
            >
              <span>{option.label}</span>
              {active && <IconCheck size={14} className="shrink-0 text-accent" aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PricingCatalogView() {
  const [catalog, setCatalog] = useState<PricingCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [providerKey, setProviderKey] = useState('');
  const [sort, setSort] = useState<PricingViewSortKey>(DEFAULT_PRICING_VIEW_SORT);

  const deferredQuery = useDeferredValue(searchInput);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void fetchPricingCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setCatalog(null);
          setError(reason instanceof Error ? reason.message : '模型价格加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [retryVersion]);

  const directModels = useMemo(
    () => filterDirectPricingCatalog(catalog?.models ?? []),
    [catalog?.models],
  );

  const providerOptions = useMemo(
    () => buildProviderOptions(directModels),
    [directModels],
  );

  const rows = useMemo(
    () =>
      filterAndSortPricingRows(directModels, {
        query: deferredQuery,
        providerKey,
        sort,
      }),
    [deferredQuery, directModels, providerKey, sort],
  );

  const hasFilters = Boolean(searchInput.trim() || providerKey);

  if (loading) {
    return <PricingSkeleton />;
  }

  if (error) {
    return (
      <section aria-labelledby="pricing-heading">
        <header className="border-b border-black/6 px-4 py-3.5 sm:px-5 dark:border-white/6">
          <h1 id="pricing-heading" className="text-[18px]/6 font-semibold text-foreground">
            模型价格
          </h1>
        </header>
        <div role="status" className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-medium text-foreground">模型价格加载失败</p>
          <p className="text-sm text-muted">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1 cursor-pointer"
            onClick={() => setRetryVersion((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="@container" aria-labelledby="pricing-heading">
      <header className={cn(headerLayout, 'sticky top-0 z-10 bg-white/95 backdrop-blur-sm dark:bg-surface/95')}>
        <div className="flex items-baseline gap-2.5">
          <h1 id="pricing-heading" className="text-[18px]/6 font-semibold text-foreground">
            模型价格
          </h1>
          <span className="text-sm text-muted tabular-nums">
            {hasFilters ? `${rows.length} / ${directModels.length} 个模型` : `${directModels.length} 个模型`}
          </span>
        </div>

        <div
          aria-label="模型筛选与排序"
          className={filterLayout}
        >
          <ProviderFilterPopover
            options={providerOptions}
            totalCount={directModels.length}
            value={providerKey}
            onChange={setProviderKey}
          />
          <SortDropdown value={sort} onChange={setSort} />

          <div className={cn(searchLayout, 'relative flex h-8 min-w-0 items-center rounded-md border border-transparent bg-[#f4f4f5] px-2.5 transition-colors focus-within:border-accent focus-within:bg-surface dark:bg-surface-secondary dark:focus-within:bg-surface')}>
            <Input
              type="text"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              aria-label="搜索模型名称或 ID"
              placeholder="搜索模型名称或 ID"
              className="h-full border-0 bg-transparent p-0 pr-5 text-sm focus-visible:ring-0"
            />
            {searchInput ? (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setSearchInput('')}
                className="absolute right-1.5 inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:text-foreground"
              >
                <IconX size={13} stroke={2} aria-hidden="true" />
              </button>
            ) : (
              <IconSearch
                size={14}
                stroke={1.8}
                aria-hidden="true"
                className="pointer-events-none absolute right-2.5 text-muted"
              />
            )}
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium text-foreground">没有匹配的模型</p>
          <p className="text-sm text-muted">请尝试其他关键词或切换供应商</p>
          {hasFilters && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 cursor-pointer"
              onClick={() => {
                setSearchInput('');
                setProviderKey('');
              }}
            >
              重置筛选
            </Button>
          )}
        </div>
      ) : (
        <div className={gridWrapperClass}>
          <div className={gridContainerClass}>
            {rows.map((row) => (
              <PricingModelCard key={row.model} row={row} className={gridCellBorder} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

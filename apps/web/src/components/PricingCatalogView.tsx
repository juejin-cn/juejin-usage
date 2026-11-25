import { PageCardHeading } from '@web/components/PageCardHeading';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { IconSearch, IconSortAscendingLetters, IconSortAscendingNumbers, IconSortDescendingLetters, IconSortDescendingNumbers, IconX } from '@tabler/icons-react';
import { fetchPricingCatalog, type PricingCatalogResponse } from '@/lib/api';
import { filterDirectPricingCatalog } from '@/lib/pricing-catalog';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from '@web/components/ui/combobox';
import {
  buildProviderOptions,
  DEFAULT_PRICING_VIEW_SORT,
  filterAndSortPricingRows,
  PRICING_SORT_OPTIONS,
  type PricingProviderOption,
  type PricingViewSortKey,
} from '@web/lib/pricing-view';
import { cn } from '@web/lib/utils';
import { UsageEmptyAction, UsageEmptyIllustration } from './UsageEmptyState';
import { PricingModelCard } from './PricingModelCard';

const headerLayout = 'bg-white dark:bg-surface flex flex-col gap-4 border-b border-black/6 px-4 py-4 sm:px-5 sm:py-5 dark:border-white/6';
const filterLayout = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @lg:grid-cols-[auto_auto_minmax(0,1fr)]';
const searchLayout = 'col-span-full @lg:col-span-1 @lg:w-52 @lg:justify-self-end';

const gridWrapperClass = '@container overflow-hidden';
const gridContainerClass =
  '-mr-px -mb-px grid grid-cols-1 @lg:grid-cols-2 @3xl:grid-cols-3';
const gridCellBorder = 'border-r border-b border-black/6 dark:border-white/6';

function PricingSkeleton() {
  return (
    <section className="@container" aria-label="模型价格加载中" role="status">
      <span className="sr-only">正在加载模型价格</span>
      <div className={cn(headerLayout, 'motion-safe:animate-pulse')}>
        <div className="space-y-2">
          <div className="h-8 w-28 rounded bg-surface-secondary sm:h-9" />
          <div className="h-5 w-40 rounded bg-surface-secondary" />
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
  value,
  onChange,
}: {
  options: readonly PricingProviderOption[];
  value: string;
  onChange: (next: string) => void;
}) {
  const items = useMemo(() => [
    { key: '', label: '全部供应商', icon: '', count: 0 },
    ...options,
  ], [options]);
  const selected = items.find(option => option.key === value) ?? items[0];

  return (
    <Combobox items={items} value={selected} onValueChange={option => onChange(option?.key ?? '')}
      itemToStringLabel={option => option.label} isItemEqualToValue={(a, b) => a.key === b.key}>
      <div className="inline-flex h-8 min-w-0 items-center rounded-md bg-secondary">
        <ComboboxTrigger render={<Button variant="secondary" size="sm" />}
          aria-label={`供应商筛选：${selected.label}`}
          className={cn('min-w-0 flex-1', value && 'rounded-r-none border-r-0')}>
          <span className="max-w-36 truncate">{selected.label}</span>
        </ComboboxTrigger>
        {value && (
          <Button variant="secondary" size="icon-sm" aria-label="清除供应商筛选"
            className="rounded-l-none border-l-0" onClick={() => onChange('')}>
            <IconX aria-hidden="true" />
          </Button>
        )}
      </div>
      <ComboboxContent className="flex w-[23rem] min-w-0 max-w-[min(var(--available-width),calc(100vw-1rem))] flex-col">
        <div className="relative m-2 shrink-0">
          <ComboboxInput render={<Input />} aria-label="搜索供应商" placeholder="搜索供应商" className="h-8 pr-8" />
          <IconSearch aria-hidden="true" className="pointer-events-none absolute right-2 top-2 size-4 text-muted" />
        </div>
        <ComboboxEmpty>没有匹配的供应商</ComboboxEmpty>
        <ComboboxList aria-label="供应商筛选列表" className="min-h-0 max-h-72 px-2 pb-2 [scrollbar-width:thin]">
          {(option: typeof selected) => (
            <ComboboxItem key={option.key} value={option} showIndicator={Boolean(option.key)}>
              {option.key && <ModelProviderIcon provider={option} size={16} />}
              <span className="min-w-0 truncate">{option.label}</span>
              {option.key && <Badge variant="secondary" className="rounded-md bg-black/[0.07] font-normal text-muted tabular-nums dark:bg-white/10">{option.count} 个模型</Badge>}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function sortIcon(key: PricingViewSortKey) {
  if (key === 'model:asc') return IconSortAscendingLetters;
  if (key === 'model:desc') return IconSortDescendingLetters;
  return key.endsWith(':asc') ? IconSortAscendingNumbers : IconSortDescendingNumbers;
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

  const ActiveIcon = sortIcon(value);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="secondary" size="sm" />}
        aria-label={`排序方式：${activeOption.label}`}>
        <ActiveIcon aria-hidden="true" />
        {activeOption.shortLabel}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" aria-label="排序选项">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {PRICING_SORT_OPTIONS.map(option => {
            const Icon = sortIcon(option.key);
            return (
              <DropdownMenuRadioItem key={option.key} value={option.key}
                className="focus:bg-secondary focus:text-secondary-foreground focus:**:text-secondary-foreground data-highlighted:bg-secondary">
                <Icon aria-hidden="true" className="text-muted" />
                {option.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
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
        <header className={headerLayout}>
          <PageCardHeading id="pricing-heading" title="模型价格" description="比较模型的输入、输出和缓存价格。" />
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
      <header className={cn(headerLayout, 'sm:sticky sm:top-0 sm:z-10')}>
        <PageCardHeading
          id="pricing-heading"
          title="模型价格"
          description={hasFilters
            ? `共 ${directModels.length} 个模型，当前筛选匹配 ${rows.length} 个。`
            : `比较 ${directModels.length} 个模型的输入、输出和缓存价格。`}
        />

        <div
          aria-label="模型筛选与排序"
          className={filterLayout}
        >
          <ProviderFilterPopover
            options={providerOptions}
            value={providerKey}
            onChange={setProviderKey}
          />
          <SortDropdown value={sort} onChange={setSort} />

          <div className={cn(searchLayout, 'relative min-w-0')}>
            <Input
              type="text"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              aria-label="搜索模型名称或 ID"
              placeholder="搜索模型名称或 ID"
              className="h-8 border-transparent bg-secondary pr-9 text-sm shadow-none dark:bg-secondary"
            />
            {searchInput ? (
              <Button variant="ghost" size="icon-xs" aria-label="清空搜索"
                onClick={() => setSearchInput('')} className="absolute right-1 top-1">
                <IconX aria-hidden="true" />
              </Button>
            ) : (
              <IconSearch aria-hidden="true" className="pointer-events-none absolute right-2 top-2 size-4 text-muted" />
            )}
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="flex min-h-[clamp(248px,24vw,308px)] flex-col items-center justify-center p-6 text-center">
          <UsageEmptyIllustration />
          <p className="mt-1 text-[15px]/6 font-medium text-foreground">没有匹配的模型</p>
          <p className="text-sm text-muted">请尝试其他关键词或切换供应商</p>
          {hasFilters && (
            <UsageEmptyAction className="mt-5"
              onClick={() => {
                setSearchInput('');
                setProviderKey('');
              }}
            >
              重置筛选
            </UsageEmptyAction>
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

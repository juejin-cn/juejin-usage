/** 排行榜模型级联筛选器：按识别出的厂商动态归类，并将最终模型名交给现有筛选接口。 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from '@gravity-ui/icons';
import { Button, Label, Popover, SearchField } from '@heroui/react';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import {
  groupRankModelsByVendor,
  type RankModelVendorKey,
} from '@/lib/leaderboard';
import { cn } from '@/lib/utils';

const FILTER_CONTROL_HEIGHT = '!h-8 !min-h-8';

export function RankModelCascadeSelect({
  models,
  onChange,
  value,
}: {
  models: readonly string[];
  onChange: (model: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const allGroups = useMemo(() => groupRankModelsByVendor(models), [models]);
  const groups = useMemo(
    () => groupRankModelsByVendor(models, query),
    [models, query],
  );
  const selectedGroup = allGroups.find((group) => group.models.includes(value));
  const allModels = useMemo(
    () => [...new Set(models.filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [models],
  );
  const [activeVendor, setActiveVendor] = useState<RankModelVendorKey>(
    selectedGroup?.key ?? 'all',
  );

  const visibleVendor =
    !query && activeVendor === 'all'
      ? 'all'
      : groups.some((group) => group.key === activeVendor)
        ? activeVendor
        : groups[0]?.key;
  const activeGroup = groups.find((group) => group.key === visibleVendor);
  const visibleModels =
    visibleVendor === 'all'
      ? allModels
      : (activeGroup?.models ?? []);
  const label =
    selectedGroup && value ? `${selectedGroup.label} › ${value}` : '全部模型';

  useEffect(() => {
    if (!open) return;
    setActiveVendor(selectedGroup?.key ?? 'all');
  }, [open, selectedGroup]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery('');
  };

  const selectModel = (model: string) => {
    onChange(model);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover isOpen={open} onOpenChange={handleOpenChange}>
      <Button
        aria-label={`模型筛选：${label}`}
        className={`${FILTER_CONTROL_HEIGHT} min-w-0 max-w-[7.5rem] shrink justify-between gap-1.5 px-2.5 !text-xs font-normal sm:max-w-52 sm:shrink-0 sm:px-3`}
        size="sm"
        variant="secondary"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" />
      </Button>

      <Popover.Content
        className="w-[min(34rem,calc(100vw-1rem))] overflow-hidden rounded-xl border-0 bg-overlay p-0 text-overlay-foreground shadow-surface"
        placement="bottom start"
      >
        <Popover.Dialog className="p-0 outline-none">
          <Popover.Heading className="sr-only">模型筛选</Popover.Heading>
          <SearchField
            className="border-b border-border p-2"
            value={query}
            onChange={setQuery}
          >
            <Label className="sr-only">搜索厂商或模型</Label>
            <SearchField.Group className="!h-8 !min-h-8 focus-within:!border-border focus-within:!shadow-none focus-within:!outline-none focus-within:!ring-0">
              <SearchField.SearchIcon />
              <SearchField.Input
                autoFocus
                className="!text-xs"
                placeholder="搜索厂商或模型"
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>

          {groups.length > 0 ? (
            <div className="grid min-h-56 grid-cols-[minmax(7.5rem,0.8fr)_minmax(0,1.4fr)] divide-x divide-border">
              <div
                aria-label="模型厂商"
                className="max-h-72 overscroll-contain overflow-y-auto p-1.5"
                role="listbox"
              >
                {!query ? (
                  <button
                    className={cn(
                      'mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-surface-secondary',
                      !value && 'bg-accent/10 text-foreground',
                    )}
                    type="button"
                    onClick={() => {
                      if (value) selectModel('');
                      else setActiveVendor('all');
                    }}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {!value ? <Check className="size-3 text-accent" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 font-medium">全部厂商</span>
                    <span className="shrink-0 tabular-nums text-[10px] text-muted">
                      {allModels.length}
                    </span>
                  </button>
                ) : null}
                {groups.map((group) => {
                  const active = group.key === visibleVendor;
                  const containsSelected = group.models.includes(value);
                  return (
                    <button
                      aria-selected={active}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors hover:bg-surface-secondary',
                        active && 'bg-surface-secondary text-foreground',
                      )}
                      key={group.key}
                      role="option"
                      type="button"
                      onClick={() => setActiveVendor(group.key)}
                      onMouseEnter={() => setActiveVendor(group.key)}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-white">
                        <ModelProviderIcon provider={group} size={13} />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {group.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-[10px] text-muted">
                        {group.models.length}
                      </span>
                      {containsSelected ? (
                        <Check className="size-3 shrink-0 text-accent" />
                      ) : (
                        <ChevronRight className="size-3 shrink-0 text-muted" />
                      )}
                    </button>
                  );
                })}
              </div>

              <div
                aria-label={visibleVendor === 'all' ? '全部模型' : '具体模型'}
                className="max-h-72 overscroll-contain overflow-y-auto p-1.5"
                role="listbox"
              >
                {visibleModels.map((model) => {
                  const selected = model === value;
                  return (
                    <button
                      aria-selected={selected}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-secondary',
                        selected && 'bg-accent/10 text-foreground hover:bg-accent/15',
                      )}
                      key={model}
                      role="option"
                      type="button"
                      onClick={() => selectModel(model)}
                    >
                      <span className="min-w-0 flex-1 truncate">{model}</span>
                      {selected ? <Check className="size-3 shrink-0 text-accent" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex min-h-40 items-center justify-center px-6 text-center text-xs text-muted">
              没有匹配的厂商或模型
            </div>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

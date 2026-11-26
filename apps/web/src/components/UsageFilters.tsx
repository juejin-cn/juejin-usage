import { useMemo, useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown, IconSearch, IconX } from '@tabler/icons-react';
import type { DashboardToolUsageRow } from '@/lib/dashboard-mock-data';
import { formatPct, formatTokens } from '@/lib/format';
import { ProviderIcon } from '@/components/ProviderIcon';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import {
  modelFamilyKey,
  pickModelDisplayName,
} from '@/lib/model-family';
import { getModelProvider } from '@/lib/model-provider';
import { sourceLabel } from '@/lib/tokens';
import { Input } from '@web/components/ui/input';
import { Button } from '@web/components/ui/button';
import { Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty, ComboboxTrigger } from './ui/combobox';
import { cn } from '@web/lib/utils';

interface FilterOption {
  icon: ReactNode;
  key: string;
  label: string;
  tokens: number;
}

function UsageMultiSelect({
  label,
  allLabel,
  searchPlaceholder,
  options,
  selectedKeys,
  onChange,
  disabled = false,
}: {
  label: string;
  allLabel: string;
  searchPlaceholder?: string;
  options: readonly FilterOption[];
  selectedKeys: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = options.filter(option => selectedKeys.includes(option.key));
  const single = selected.length === 1 ? selected[0] : undefined;
  const triggerLabel = single ? single.label : selected.length ? `已选 ${selected.length} 项` : '';
  const searchLabel = searchPlaceholder ?? `搜索${label}`;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) setQuery('');
  }

  const totalTokens = options.reduce((total, option) => total + option.tokens, 0);
  const term = query.trim().toLocaleLowerCase();

  return (
    <Combobox<FilterOption, true>
      multiple disabled={disabled} open={open && !disabled} onOpenChange={changeOpen}
      items={options} value={selected} onValueChange={items => onChange(items.map(item => item.key))}
      isItemEqualToValue={(a, b) => a.key === b.key} itemToStringLabel={option => option.label}
      inputValue={query} onInputValueChange={setQuery}
      filter={(option, text) => {
        const needle = text.trim().toLocaleLowerCase();
        return option.label.toLocaleLowerCase().includes(needle) || option.key.toLocaleLowerCase().includes(needle);
      }}
    >
      <div className="inline-flex h-8 max-w-full items-center rounded-md bg-secondary">
        <ComboboxTrigger render={<Button variant="secondary" size="sm" />}
          aria-label={triggerLabel ? `${label}筛选：${triggerLabel}` : `按${label}筛选`}
          className={cn('gap-1.5', selected.length > 0 && 'rounded-r-none border-r-0')}>
          <span className="max-w-40 truncate">{single?.label ?? (selected.length ? label : allLabel)}</span>
          {selected.length > 1 && <span className="tabular-nums">{triggerLabel}</span>}
          <IconChevronDown aria-hidden="true" className="size-3.5 text-muted" />
        </ComboboxTrigger>
        {selected.length > 0 && (
          <Button variant="secondary" size="icon-sm" disabled={disabled} aria-label={`清除${label}筛选`}
            className="rounded-l-none border-l-0 px-1" onClick={() => onChange([])}>
            <IconX size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      <ComboboxContent className="flex w-[23rem] min-w-0 max-w-[min(var(--available-width),calc(100vw-1rem))] flex-col p-0" aria-label={`${label}筛选`}>
        <div className="relative m-2 shrink-0">
          <ComboboxInput render={<Input />}
            aria-label={searchLabel} placeholder={searchLabel} className="h-8 pr-7" />
          {query ? (
            <button type="button" aria-label="清空搜索" className="absolute right-2 top-2" onClick={() => setQuery('')}>
              <IconX size={16} aria-hidden="true" />
            </button>
          ) : <IconSearch aria-hidden="true" className="pointer-events-none absolute right-2 top-2 size-4 text-muted" />}
        </div>
        {!term && (
          <Button variant="ghost" size="sm" className="mx-2 mb-1 shrink-0 justify-start gap-2"
            onClick={() => { onChange([]); changeOpen(false); }}>
            {allLabel}<span className="ml-auto text-xs text-muted">{options.length}</span>
            {!selected.length && <IconCheck size={14} aria-hidden="true" />}
          </Button>
        )}
        <ComboboxEmpty>没有匹配项</ComboboxEmpty>
        <ComboboxList className="min-h-0 max-h-72 px-2 pb-2 [scrollbar-width:thin]" aria-label={`${label}筛选列表`}>
          {(option: FilterOption) => (
            <ComboboxItem key={option.key} value={option}>
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">{option.icon}</span>
              <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
              <span className="shrink-0 text-xs tabular-nums" title="Token 用量">{formatTokens(option.tokens)}</span>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted" title="用量占比">
                {formatPct(totalTokens ? option.tokens / totalTokens * 100 : 0)}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export function UsageFilters({
  tools,
  selectedTools,
  onToolsChange,
  selectedModels,
  onModelsChange,
  disabled = false,
}: {
  tools: DashboardToolUsageRow[];
  selectedTools: string[];
  onToolsChange: (sources: string[]) => void;
  selectedModels: string[];
  onModelsChange: (models: string[]) => void;
  disabled?: boolean;
}) {
  const toolOptions = useMemo<FilterOption[]>(
    () =>
      tools
        .filter((tool) => tool.tokens > 0)
        .map((tool) => ({
          key: tool.source,
          icon: <ProviderIcon provider={tool.source} size={16} />,
          label: sourceLabel(tool.source),
          tokens: tool.tokens,
        })),
    [tools],
  );

  const modelOptions = useMemo<FilterOption[]>(() => {
    const activeToolSet = selectedTools.length > 0 ? new Set(selectedTools) : null;
    const families = new Map<string, { tokens: number; variants: Map<string, number> }>();

    for (const tool of tools) {
      if (tool.tokens <= 0) continue;
      if (activeToolSet && !activeToolSet.has(tool.source)) continue;
      for (const model of tool.models) {
        if (!model.model || model.tokens <= 0) continue;
        const key = modelFamilyKey(model.model);
        const previous = families.get(key) ?? {
          tokens: 0,
          variants: new Map<string, number>(),
        };
        previous.tokens += model.tokens;
        previous.variants.set(
          model.model,
          (previous.variants.get(model.model) ?? 0) + model.tokens,
        );
        families.set(key, previous);
      }
    }

    return [...families.values()]
      .map((entry) => {
        const model = pickModelDisplayName(entry.variants);
        return {
          key: model,
          icon: (
            <ModelProviderIcon
              provider={getModelProvider(model)}
              fallbackText={model}
              size={16}
            />
          ),
          label: model,
          tokens: entry.tokens,
        };
      })
      .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
  }, [selectedTools, tools]);

  if (toolOptions.length === 0 && modelOptions.length === 0) {
    return null;
  }

  return (
    <div role="group" aria-label="工具和模型筛选" className="flex flex-wrap items-center gap-2">
      {toolOptions.length > 0 && (
        <UsageMultiSelect
          label="工具" allLabel="全部工具"
          options={toolOptions}
          selectedKeys={selectedTools}
          onChange={onToolsChange}
          disabled={disabled}
        />
      )}
      {modelOptions.length > 0 && (
        <UsageMultiSelect
          label="模型" allLabel="全部模型"
          options={modelOptions}
          selectedKeys={selectedModels}
          onChange={onModelsChange}
          disabled={disabled}
        />
      )}
    </div>
  );
}

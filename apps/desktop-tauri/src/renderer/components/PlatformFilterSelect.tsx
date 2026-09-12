import type { ReactNode } from 'react';
import { Check, ChevronDown } from '@gravity-ui/icons';
import { Button, Label, ListBox, Popover } from '@heroui/react';
import { ProviderIcon } from '@/components/ProviderIcon';
import { sourceLabel, TOOLTIP_SHADOW } from '@/lib/tokens';
import { cn } from '@/lib/utils';

/**
 * Text-only multi-select used by Token / Daily / Heatmap platform filters.
 * Parent owns `null = 全部` semantics; pass `value = allSources` when unfiltered.
 */
export function PlatformFilterSelect({
  allSources,
  value,
  onChange,
}: {
  allSources: string[];
  value: string[];
  onChange: (keys: string[]) => void;
}) {
  if (allSources.length === 0) return null;

  const allSelected = value.length === allSources.length;

  const label =
    value.length === 0
      ? '选择平台'
      : allSelected
        ? '全部平台'
        : `已选 ${value.length} 个平台`;

  return (
    <Popover>
      <Button
        aria-label={`筛选平台：${label}`}
        className="h-7 min-h-0 w-auto min-w-0 max-w-40 gap-1 px-2 text-xs font-medium"
        size="sm"
        variant="tertiary"
      >
        {value.length > 0 ? (
          <span className="flex items-center gap-0.5">
            {value.slice(0, 4).map((source) => (
              <span
                className="flex size-6 items-center justify-center rounded-md bg-white"
                key={source}
              >
                <ProviderIcon onLightBackground provider={source} size={14} />
              </span>
            ))}
            {value.length > 4 ? (
              <span className="px-1 text-[11px] text-muted">+{value.length - 4}</span>
            ) : null}
          </span>
        ) : (
          <span className="whitespace-nowrap">选择平台</span>
        )}
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </Button>

      <Popover.Content
        className="rounded-lg"
        placement="bottom end"
      >
        <Popover.Dialog className="p-0">
          <ListBox
            aria-label="平台列表"
            className="flex max-h-64 min-w-48 flex-col gap-1 overflow-y-auto p-2"
            selectedKeys={new Set(value)}
            selectionMode="multiple"
            onSelectionChange={(keys) => onChange([...keys].map(String))}
          >
            {allSources.map((source) => (
              <ListBox.Item
                className="min-w-0 gap-3 rounded-lg px-2 py-1.5 text-xs data-[selected=true]:bg-accent/10"
                id={source}
                key={source}
                textValue={sourceLabel(source)}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-black/10 bg-white text-black shadow-xs">
                  <ProviderIcon onLightBackground provider={source} size={22} />
                </span>
                <Label className="min-w-0 flex-1 truncate font-medium">
                  {sourceLabel(source)}
                </Label>
                <ListBox.ItemIndicator>
                  {({ isSelected }) =>
                    isSelected ? (
                      <Check className="size-4 text-accent-soft-foreground" />
                    ) : null
                  }
                </ListBox.ItemIndicator>
              </ListBox.Item>
            ))}
          </ListBox>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

/** Normalize onChange so selecting all keys collapses to `null` (=全部). */
export function applyPlatformFilterChange(
  keys: string[],
  allSources: string[],
  setSelected: (next: string[] | null) => void,
): void {
  if (keys.length === 0) {
    setSelected([]);
    return;
  }
  if (
    keys.length === allSources.length &&
    allSources.every((source) => keys.includes(source))
  ) {
    setSelected(null);
    return;
  }
  setSelected(keys);
}

/** Optional custom multi-key filter trigger (e.g. models). */
export function KeyFilterSelect({
  allKeys,
  value,
  onChange,
  heading,
  fullLabel,
  emptyLabel,
  triggerLabel,
  triggerIcon,
  renderOption,
}: {
  allKeys: string[];
  value: string[];
  onChange: (keys: string[]) => void;
  heading: string;
  fullLabel: string;
  emptyLabel: string;
  triggerLabel: (keys: string[], allSelected: boolean) => string;
  triggerIcon?: (keys: string[]) => ReactNode;
  renderOption: (key: string) => ReactNode;
}) {
  if (allKeys.length === 0) return null;

  const selected = new Set(value);
  const allSelected = value.length === allKeys.length;
  const isFiltered = !allSelected && value.length > 0;
  const label =
    triggerLabel(value, allSelected) ||
    (allSelected ? fullLabel : emptyLabel);

  const toggleKey = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange([...next]);
  };

  return (
    <Popover>
      <Button
        aria-label={`筛选：${label}`}
        className={cn(
          'h-auto min-h-0 max-w-36 gap-1 rounded-none border-0 bg-transparent p-0',
          'text-xs font-medium text-muted shadow-none',
          'hover:bg-transparent hover:text-foreground',
          'data-[pressed=true]:bg-transparent data-[pressed=true]:text-foreground',
          isFiltered && 'text-foreground',
        )}
        size="sm"
        variant="ghost"
      >
        {triggerIcon?.(value)}
        <span className="min-w-0 max-w-28 truncate whitespace-nowrap">
          {label}
        </span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </Button>

      <Popover.Content
        className="min-w-56 overflow-hidden rounded-[10px] border border-border bg-overlay p-0 text-overlay-foreground"
        placement="bottom end"
        style={{ boxShadow: TOOLTIP_SHADOW }}
      >
        <Popover.Dialog className="p-0 outline-none">
          <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
            <Popover.Heading className="text-[10px] font-semibold tracking-wider text-muted">
              {heading}
            </Popover.Heading>
            <div className="flex items-center gap-1">
              <button
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-secondary hover:text-foreground"
                type="button"
                onClick={() => onChange([...allKeys])}
              >
                全部
              </button>
              <span aria-hidden="true" className="text-border">
                ·
              </span>
              <button
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-secondary hover:text-foreground"
                type="button"
                onClick={() => onChange([])}
              >
                清空
              </button>
            </div>
          </div>

          <ul
            aria-multiselectable="true"
            className="max-h-64 overflow-y-auto p-1.5"
            role="listbox"
          >
            {allKeys.map((key) => {
              const isSelected = selected.has(key);
              return (
                <li aria-selected={isSelected} key={key} role="option">
                  <button
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-xs transition-colors',
                      'hover:bg-surface-secondary',
                      isSelected && 'bg-accent/10 hover:bg-accent/15',
                    )}
                    type="button"
                    onClick={() => toggleKey(key)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                        isSelected
                          ? 'border-accent bg-accent text-accent-foreground'
                          : 'border-border bg-surface',
                      )}
                    >
                      {isSelected ? <Check className="size-2.5" /> : null}
                    </span>
                    {renderOption(key)}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

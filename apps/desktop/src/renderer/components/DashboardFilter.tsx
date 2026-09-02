import { useMemo } from 'react';
import { Xmark } from '@gravity-ui/icons';
import {
  Button,
  ButtonGroup,
  Label,
  ListBox,
  Select,
  Tabs,
} from '@heroui/react';
import { FilterChromeActions } from '@/components/FilterChromeActions';
import { ProviderIcon } from '@/components/ProviderIcon';
import type { DashboardToolUsageRow } from '@/lib/dashboard-mock-data';
import { sourceLabel } from '@/lib/tokens';
import { type DashboardRange } from '../../shared/dashboard-range';

export {
  DASHBOARD_RANGE_DAYS,
  type DashboardRange,
} from '../../shared/dashboard-range';

const RANGE_OPTIONS: readonly { id: DashboardRange; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'last-7-days', label: '7D' },
  { id: 'last-30-days', label: '30D' },
  { id: 'last-90-days', label: '90D' },
];

const FILTER_CONTROL_HEIGHT = '!h-8 !min-h-8';

export function DashboardFilter({
  value,
  onChange,
  tools,
  selectedTools,
  onToolsChange,
  disabled = false,
}: {
  value: DashboardRange;
  onChange: (value: DashboardRange) => void;
  tools: DashboardToolUsageRow[];
  /** Empty = all available tools. */
  selectedTools: string[];
  onToolsChange: (sources: string[]) => void;
  /** When true, ignore range/tool changes (e.g. while local range sync runs). */
  disabled?: boolean;
}) {
  const availableTools = useMemo(
    () => tools.filter((tool) => tool.tokens > 0),
    [tools],
  );

  return (
    <div className="mb-5 flex min-w-0 items-center gap-2" aria-label="筛选条件">
      <div className="shrink-0 sm:hidden">
        <RangeSelect
          disabled={disabled}
          value={value}
          onChange={onChange}
        />
      </div>
      <Tabs
        className="hidden w-fit shrink-0 text-center sm:block"
        selectedKey={value}
        onSelectionChange={(key) => {
          if (disabled) return;
          onChange(String(key) as DashboardRange);
        }}
      >
        <Tabs.ListContainer>
          <Tabs.List
            aria-label="时间范围"
            className="w-fit *:h-6 *:w-fit *:px-3 *:text-sm *:font-normal *:transition-none! *:data-[selected=true]:text-accent-foreground"
          >
            {RANGE_OPTIONS.map((option) => (
              <Tabs.Tab className="transition-none!" id={option.id} key={option.id}>
                <span className="text-xs font-normal">{option.label}</span>
                <Tabs.Indicator className="bg-accent transition-none!" />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      {/* Always reserve the tools slot so Tabs don't shift when tools appear/vanish. */}
      <div className="flex min-h-8 min-w-0 shrink-0 items-center">
        {availableTools.length > 0 ? (
          <ToolChannelSelect
            selectedTools={selectedTools}
            tools={availableTools}
            onChange={(sources) => {
              if (disabled) return;
              onToolsChange(sources);
            }}
          />
        ) : null}
      </div>

      <div className="ml-auto shrink-0">
        <FilterChromeActions />
      </div>
    </div>
  );
}

function RangeSelect({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (value: DashboardRange) => void;
  value: DashboardRange;
}) {
  return (
    <Select
      aria-label="时间范围"
      className="min-w-0 max-w-[7.5rem] shrink text-xs"
      isDisabled={disabled}
      value={value}
      variant="secondary"
      onChange={(key) => {
        if (disabled || key == null) return;
        onChange(String(key) as DashboardRange);
      }}
    >
      <Label className="sr-only">时间范围</Label>
      <Select.Trigger
        className={`${FILTER_CONTROL_HEIGHT} !w-fit max-w-[7.5rem] items-center leading-none ps-2.5 pe-7 !text-xs font-normal`}
      >
        <Select.Value className="min-w-0 max-w-20 !text-xs" />
        <Select.Indicator className="size-3.5 text-muted" />
      </Select.Trigger>
      <Select.Popover className="w-50 rounded-xl bg-surface shadow-md" placement="bottom start">
        <ListBox aria-label="时间范围">
          {RANGE_OPTIONS.map((option) => (
            <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/** The dashboard's single, compact multi-select entry point for tools. */
export function ToolChannelSelect({
  tools,
  selectedTools,
  onChange,
}: {
  tools: DashboardToolUsageRow[];
  selectedTools: string[];
  onChange: (sources: string[]) => void;
}) {
  const availableSources = useMemo(
    () => new Set(tools.map((tool) => tool.source)),
    [tools],
  );
  const value = selectedTools.filter((source) => availableSources.has(source));
  const hasSelection = value.length > 0;

  return (
    <ButtonGroup className="shrink-0">
      <Select
        aria-label="筛选渠道"
        className="w-fit max-w-52 text-xs"
        selectionMode="multiple"
        value={value}
        variant="secondary"
        onChange={(keys) => {
          const next = Array.isArray(keys)
            ? keys.map(String)
            : keys == null
              ? []
              : [String(keys)];
          onChange(next.filter((source) => availableSources.has(source)));
        }}
      >
        <Label className="sr-only">渠道</Label>
        <Select.Trigger
          className={`!h-8 !min-h-8 !w-fit max-w-52 ps-3 pe-8 !text-xs font-normal ${
            hasSelection ? '!rounded-r-none' : '!rounded-full'
          }`}
        >
          <Select.Value className="min-w-0 max-w-40 !text-xs">
            {({ state }) => {
              const selected = state.selectedItems
                .map((item) => tools.find((tool) => tool.source === item.key))
                .filter((tool): tool is DashboardToolUsageRow => Boolean(tool));
              if (selected.length === 0) return '全部渠道';
              if (selected.length > 1) return `已选 ${selected.length} 个渠道`;

              const [tool] = selected;
              return tool ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <ProviderIcon provider={tool.source} size={18} />
                  <span className="truncate">{sourceLabel(tool.source)}</span>
                </span>
              ) : '全部渠道';
            }}
          </Select.Value>
          <Select.Indicator className="size-3.5 text-muted" />
        </Select.Trigger>
        <Select.Popover
          className="w-50 rounded-xl bg-surface shadow-md"
          placement="bottom start"
        >
          <ListBox aria-label="渠道列表" selectionMode="multiple">
            {tools.map((tool) => (
              <ListBox.Item
                className="py-1 rounded-lg px-1.5 text-xs gap-2!"
                id={tool.source}
                key={tool.source}
                textValue={sourceLabel(tool.source)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md ">
                  <ProviderIcon provider={tool.source} size={18} />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {sourceLabel(tool.source)}
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      {hasSelection ? (
        <Button
          aria-label="清空渠道筛选"
          className="!h-8 !min-h-8 !w-8 !min-w-8 !rounded-l-none !rounded-r-full p-0"
          size="sm"
          variant="tertiary"
          onPress={() => onChange([])}
        >
          <ButtonGroup.Separator />
          <Xmark className="size-3.5" />
        </Button>
      ) : null}
    </ButtonGroup>
  );
}

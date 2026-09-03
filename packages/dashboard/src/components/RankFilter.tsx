import { useState } from 'react';
import { LogoGithub } from '@gravity-ui/icons';
import { Button, Label, ListBox, Select, Tabs, Tooltip } from '@heroui/react';
import { Share2 } from 'lucide-react';
import { ProviderIcon } from '@/components/ProviderIcon';
import { RankModelCascadeSelect } from '@/components/RankModelCascadeSelect';
import { RankShareModal } from '@/components/RankShareModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { GITHUB_REPO_URL } from '@/lib/downloads';
import type {
  LeaderboardBoard,
  LeaderboardMetric,
  LeaderboardUserProfile,
} from '@/lib/api';
import type { RankRange } from '@/lib/leaderboard';

const RANGE_OPTIONS: readonly { id: RankRange; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '本周' },
  { id: 'month', label: '本月' },
  { id: 'all', label: '全部' },
];

const FILTER_CONTROL_HEIGHT = '!h-8 !min-h-8';
const FILTER_POPOVER = 'w-50 !max-h-64 overflow-hidden rounded-xl bg-surface shadow-md';
const FILTER_POPOVER_LIST = '!max-h-64 overflow-y-auto!';

function openGithubRepository(): void {
  const opened = window.open(GITHUB_REPO_URL, '_blank');
  if (opened) {
    opened.opener = null;
    return;
  }
  window.location.assign(GITHUB_REPO_URL);
}

export function RankFilter({
  loading,
  metric,
  model,
  modelOptions,
  onModelChange,
  onToolChange,
  profiles,
  board,
  tool,
  tools,
  value,
  onChange,
}: {
  loading: boolean;
  metric: LeaderboardMetric;
  model: string;
  modelOptions: readonly { tool: string; model: string }[];
  onModelChange: (model: string) => void;
  onToolChange: (tool: string) => void;
  profiles: Record<string, LeaderboardUserProfile>;
  board: LeaderboardBoard | null;
  tool: string;
  tools: readonly { key: string; displayName: string }[];
  value: RankRange;
  onChange: (value: RankRange) => void;
}) {
  const [isShareOpen, setIsShareOpen] = useState(false);
  const toolLabel = tools.find((item) => item.key === tool)?.displayName ?? '全部工具';
  const modelLabel = model || '全部模型';

  return (
    <div
      aria-label="排行榜筛选"
      className="mb-4 flex w-full min-w-0 items-center gap-1.5 sm:gap-2"
    >
      {/* Mobile: compact range select. Desktop: tabs. */}
      <div className="shrink-0 sm:hidden">
        <RankSelect
          ariaLabel="时间范围"
          options={RANGE_OPTIONS.map((option) => ({
            id: option.id,
            label: option.label,
          }))}
          placeholder="时间范围"
          value={value}
          onChange={(next) => onChange(next as RankRange)}
          allowEmpty={false}
        />
      </div>
      <Tabs
        className="hidden w-fit shrink-0 text-center sm:block"
        selectedKey={value}
        onSelectionChange={(key) => onChange(String(key) as RankRange)}
      >
        <Tabs.ListContainer>
          <Tabs.List
            aria-label="时间范围"
            className="w-fit *:h-6 *:w-fit *:px-3 *:text-sm *:font-normal *:data-[selected=true]:text-accent-foreground"
          >
            {RANGE_OPTIONS.map((option) => (
              <Tabs.Tab id={option.id} key={option.id}>
                <span className="text-xs font-normal">{option.label}</span>
                <Tabs.Indicator className="bg-accent" />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      <ToolSelect tools={tools} value={tool} onChange={onToolChange} />
      <RankModelCascadeSelect
        models={modelOptions.map((item) => item.model)}
        value={model}
        onChange={onModelChange}
      />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip closeDelay={80} delay={100}>
          <Button
            aria-label="GitHub 仓库"
            className="size-8 min-h-8 min-w-8 shrink-0 p-0"
            isIconOnly
            onPress={openGithubRepository}
            size="sm"
            variant="tertiary"
          >
            <LogoGithub className="size-4" />
          </Button>
          <Tooltip.Content placement="bottom">
            <p>GitHub 仓库</p>
          </Tooltip.Content>
        </Tooltip>
        <Tooltip closeDelay={80} delay={100}>
          <Button
            aria-label="分享排行榜"
            className="size-8 min-h-8 min-w-8 shrink-0 p-0"
            isIconOnly
            onPress={() => setIsShareOpen(true)}
            size="sm"
            variant="tertiary"
          >
            <Share2 className="size-4" />
          </Button>
          <Tooltip.Content placement="bottom">
            <p>分享</p>
          </Tooltip.Content>
        </Tooltip>
        <ThemeToggle />
      </div>

      <RankShareModal
        board={board}
        loading={loading}
        metric={metric}
        modelLabel={modelLabel}
        onOpenChange={setIsShareOpen}
        open={isShareOpen}
        profiles={profiles}
        toolLabel={toolLabel}
      />
    </div>
  );
}

function ToolSelect({
  onChange,
  tools,
  value,
}: {
  onChange: (value: string) => void;
  tools: readonly { key: string; displayName: string }[];
  value: string;
}) {
  const selected = tools.find((item) => item.key === value);

  return (
    <Select
      aria-label="工具筛选"
      className="min-w-0 max-w-[7.5rem] shrink text-xs sm:max-w-52 sm:shrink-0"
      variant="secondary"
      value={value || 'all'}
      onChange={(key) => onChange(key === 'all' || key == null ? '' : String(key))}
    >
      <Label className="sr-only">工具筛选</Label>
      <Select.Trigger
        className={`${FILTER_CONTROL_HEIGHT} !w-fit max-w-[7.5rem] items-center leading-none ps-2.5 pe-7 !text-xs font-normal sm:max-w-52 sm:ps-3 sm:pe-8`}
      >
        <Select.Value className="min-w-0 max-w-20 !text-xs sm:max-w-40">
          {() =>
            selected ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <ProviderIcon provider={selected.key} size={14} />
                <span className="truncate">{selected.displayName}</span>
              </span>
            ) : (
              '全部工具'
            )
          }
        </Select.Value>
        <Select.Indicator className="size-3.5 text-muted" />
      </Select.Trigger>
      <Select.Popover className={FILTER_POPOVER} placement="bottom start">
        <ListBox aria-label="工具筛选" className={FILTER_POPOVER_LIST}>
          <ListBox.Item id="all" textValue="全部工具">
            全部工具
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {tools.map((item) => (
            <ListBox.Item
              className="gap-2! rounded-lg px-1.5 py-1 text-xs"
              id={item.key}
              key={item.key}
              textValue={item.displayName}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                <ProviderIcon provider={item.key} size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate">{item.displayName}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function RankSelect({
  allowEmpty = true,
  ariaLabel,
  onChange,
  options,
  placeholder,
  value,
}: {
  allowEmpty?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
  options: readonly { id: string; label: string }[];
  placeholder: string;
  value: string;
}) {
  return (
    <Select
      aria-label={ariaLabel}
      className="min-w-0 max-w-[7.5rem] shrink text-xs sm:max-w-52 sm:shrink-0"
      variant="secondary"
      value={allowEmpty ? value || 'all' : value}
      onChange={(key) => {
        if (allowEmpty) {
          onChange(key === 'all' || key == null ? '' : String(key));
          return;
        }
        if (key == null) return;
        onChange(String(key));
      }}
    >
      <Label className="sr-only">{ariaLabel}</Label>
      <Select.Trigger
        className={`${FILTER_CONTROL_HEIGHT} !w-fit max-w-[7.5rem] items-center leading-none ps-2.5 pe-7 !text-xs font-normal sm:max-w-52 sm:ps-3 sm:pe-8`}
      >
        <Select.Value className="min-w-0 max-w-20 !text-xs sm:max-w-40" />
        <Select.Indicator className="size-3.5 text-muted" />
      </Select.Trigger>
      <Select.Popover className={FILTER_POPOVER} placement="bottom start">
        <ListBox aria-label={ariaLabel} className={FILTER_POPOVER_LIST}>
          {allowEmpty ? (
            <ListBox.Item id="all" textValue={placeholder}>
              {placeholder}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ) : null}
          {options.map((option) => (
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

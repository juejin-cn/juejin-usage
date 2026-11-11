import { useEffect, useId, useState } from 'react';
import { Button, Label, ListBox, Popover, SearchField } from '@heroui/react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import type { ModelOption } from '@juejin-opensource/jusage-core/agent-router';
import { CHANNEL_CATALOG } from '@juejin-opensource/jusage-core/agent-router/presets';
import { ProviderIcon } from './ProviderIcon';

export function TrayRuntimeModelPicker({ models, currentModel, disabled, saving, onChange, onOpenChange }: {
  models: ModelOption[];
  currentModel?: ModelOption;
  disabled: boolean;
  saving: boolean;
  onChange: (id: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const labelId = useId();
  const valueId = useId();
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = models.filter(model => `${model.name} ${model.provider} ${model.id}`.toLocaleLowerCase().includes(needle));
  function changeOpen(next: boolean) {
    setOpen(next);
    onOpenChange(next);
    if (next) setQuery('');
  }
  return <div className="grid gap-2">
    <p id={labelId} className="text-sm text-muted">Default</p>
    <Popover isOpen={open} onOpenChange={changeOpen}>
      <Button variant="secondary" isDisabled={disabled || saving} aria-labelledby={`${labelId} ${valueId}`}
        className="h-10 w-full justify-between gap-2 rounded-[10px] border-0 bg-default px-3 text-sm font-normal text-foreground shadow-none hover:bg-default-hover data-[hovered=true]:bg-default-hover">
        <span id={valueId} className="min-w-0 truncate">{currentModel?.name ?? '选择模型'}</span>
        {saving ? <LoaderCircle aria-label="保存中" className="size-4 shrink-0 animate-spin" /> : <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted" />}
      </Button>
      <Popover.Content placement="bottom start" className="w-[366px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[10px] p-0">
        <Popover.Dialog className="flex max-h-[min(360px,calc(100vh-2rem))] flex-col gap-3 p-3 outline-none">
          <Popover.Heading className="shrink-0 text-[15px] font-medium leading-5">模型列表</Popover.Heading>
          <SearchField variant="secondary" value={query} onChange={setQuery} className="shrink-0">
            <Label className="sr-only">搜索模型或渠道</Label>
            <SearchField.Group className="h-9 min-h-9 rounded-[10px]">
              <SearchField.SearchIcon />
              <SearchField.Input autoFocus placeholder="搜索模型或渠道" className="min-w-0 text-sm" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <ListBox aria-label="模型列表" selectionMode="single" selectedKeys={currentModel ? [currentModel.id] : []}
            className="-mr-3 min-h-0 overflow-y-auto overscroll-contain py-0 pl-0 pr-3"
            renderEmptyState={() => <p role="status" className="py-6 text-center text-sm text-muted">未找到匹配的模型</p>}
            onAction={key => { changeOpen(false); if (String(key) !== currentModel?.id) onChange(String(key)); }}>
            {filtered.map(model => <ListBox.Item key={model.id} id={model.id} textValue={model.name} className="gap-2 rounded-lg px-2 py-2">
              <ProviderIcon provider={CHANNEL_CATALOG.find(channel => channel.name === model.provider || channel.id === model.provider)?.icon ?? model.provider} size={18} />
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm" title={`${model.name} · ${model.provider}`}>{model.name}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>)}
          </ListBox>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  </div>;
}

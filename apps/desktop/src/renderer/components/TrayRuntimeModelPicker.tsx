import { useEffect, useId, useState } from 'react';
import { Button, Label, ListBox, Drawer, SearchField } from '@heroui/react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import type { ModelOption } from '@juejin-opensource/jusage-core/agent-router';
import { CHANNEL_CATALOG } from '@juejin-opensource/jusage-core/agent-router/presets';
import { fetchModelCatalog } from '@/lib/gateway-model-names';
import type { ModelCatalog } from '@juejin-opensource/jusage-core/agent-router/model-metadata';
import { runtimeModelName } from '@/lib/gateway-runtimes';
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
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog>>({});
  const accountIds = [...new Set(models.flatMap(model => {
    const source = model.legacyId;
    return source && !source.startsWith('auto/') ? [source.slice(0, source.indexOf('/'))] : [];
  }))].filter(Boolean).sort().join(',');
  useEffect(() => {
    if (!open || !accountIds) return;
    let cancelled = false;
    for (const id of accountIds.split(',')) {
      void fetchModelCatalog(id).then(catalog => {
        if (!cancelled) setCatalogs(previous => ({ ...previous, [id]: catalog }));
      }).catch(() => { /* Keep the routing ID when the account catalog is unavailable. */ });
    }
    return () => { cancelled = true; };
  }, [open, accountIds]);
  const modelName = (model: ModelOption) => runtimeModelName(model, catalogs);
  const labelId = useId();
  const valueId = useId();
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = open ? models.filter(model => `${modelName(model)} ${model.name} ${model.provider} ${model.id}`.toLocaleLowerCase().includes(needle)) : [];
  function changeOpen(next: boolean) {
    setOpen(next);
    onOpenChange(next);
    if (next) setQuery('');
  }
  return <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-4">
    <p id={labelId} className="text-sm text-muted">默认模型</p>

      <Button onPress={() => changeOpen(true)} variant="secondary" isDisabled={disabled || saving} aria-labelledby={`${labelId} ${valueId}`}
        className="h-[32px] min-h-[32px] w-full justify-between gap-2 rounded-[10px] border-0 bg-default px-3 text-sm font-normal text-foreground shadow-none hover:bg-default-hover data-[hovered=true]:bg-default-hover">
        <span id={valueId} className="min-w-0 truncate">{currentModel ? modelName(currentModel) : '选择模型'}</span>
        {saving ? <LoaderCircle aria-label="保存中" className="size-4 shrink-0 animate-spin" /> : <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted" />}
      </Button>
      <Drawer.Backdrop isOpen={open} onOpenChange={changeOpen}>
        <Drawer.Content placement="bottom">
          <Drawer.Dialog className="flex max-h-[85dvh] min-h-0 flex-col overflow-hidden rounded-t-2xl p-0">
            <Drawer.Handle className="shrink-0 pb-0 pt-3" />
            <Drawer.CloseTrigger aria-label="关闭模型选择" />
            <Drawer.Header className="shrink-0 px-4 py-3 pr-14">
              <Drawer.Heading>选择默认模型</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="m-0 flex min-h-0 flex-col gap-0 overflow-hidden p-0">
          <SearchField variant="secondary" value={query} onChange={setQuery} className="mx-4 mb-2 shrink-0">
            <Label className="sr-only">搜索模型或渠道</Label>
            <SearchField.Group className="h-9 min-h-9 rounded-[10px]">
              <SearchField.SearchIcon />
              <SearchField.Input autoFocus placeholder="搜索模型或渠道" className="min-w-0 text-sm" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <ListBox aria-label="模型列表" selectionMode="single" disallowEmptySelection selectedKeys={currentModel ? [currentModel.id] : []}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-4 pt-0"
            renderEmptyState={() => <p role="status" className="py-6 text-center text-sm text-muted">未找到匹配的模型</p>}
            onSelectionChange={keys => {
              if (keys === 'all' || disabled || saving) return;
              const key = keys.values().next().value;
              if (key === undefined || String(key) === currentModel?.id) return;
              onChange(String(key));
              changeOpen(false);
            }}>
            {filtered.map(model => <ListBox.Item key={model.id} id={model.id} textValue={modelName(model)} className="gap-2 rounded-lg px-2 py-2">
              <ProviderIcon provider={CHANNEL_CATALOG.find(channel => channel.name === model.provider || channel.id === model.provider)?.icon ?? model.provider} size={18} />
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm" title={`${modelName(model)} · ${model.provider} · ${model.id}`}>{modelName(model)}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>)}
          </ListBox>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
  </div>;
}

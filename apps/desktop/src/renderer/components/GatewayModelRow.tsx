import { Button, Chip, Popover, ToggleButton, Tooltip } from '@heroui/react';
import { Check, Info } from 'lucide-react';
import { useState } from 'react';
import type { ModelMetadata } from '@juejin-opensource/jusage-core/agent-router/model-metadata';
import { modelPresentation } from '@/lib/model-presentation';

export function GatewayModelRow({ id, name, metadata, now, selected, disabled, onChange }: {
  id: string; name: string; metadata?: ModelMetadata; now: number; selected: boolean; disabled: boolean; onChange: (selected: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { tags, details } = modelPresentation(metadata, now);
  const panel = <div className="grid max-w-80 gap-1.5 text-xs">{details.map((line, index) => <p key={index}>{line}</p>)}</div>;
  return <div className={`inline-flex h-7 min-w-0 max-w-full items-center gap-0.5 rounded-full pl-1 pr-1 ${selected ? 'bg-accent-soft text-accent-soft-foreground' : 'bg-default text-foreground'}`}>
    {details.length ? <Popover isOpen={open} onOpenChange={setOpen}>
      <Tooltip isDisabled={open} delay={150}>
        <Button isIconOnly size="sm" variant="ghost" aria-label={`${name} 模型信息`} className="size-5 min-h-5 min-w-5 shrink-0 rounded-full bg-transparent! p-0 text-current">
          <Info aria-hidden="true" className="size-3.5" />
        </Button>
        <Tooltip.Content placement="top">{panel}</Tooltip.Content>
      </Tooltip>
      <Popover.Content placement="bottom end">
        <Popover.Dialog className="p-3 outline-none">
          <Popover.Heading className="mb-2 text-sm font-medium">{name}</Popover.Heading>
          {panel}
        </Popover.Dialog>
      </Popover.Content>
    </Popover> : null}
    <ToggleButton variant="ghost" size="sm" isSelected={selected} isDisabled={disabled} onChange={onChange}
      aria-label={`${name}，${selected ? '已启用' : '未启用'}`}
      className="transform-none! h-7 min-w-0 max-w-full gap-1 rounded-full bg-transparent! px-1 text-xs shadow-none! md:h-7 [&_svg]:size-3">
      <span title={id} className="min-w-0 truncate">{name}</span>
      <span className="flex shrink-0 items-center gap-1 text-[11px]">{tags.map(tag => <Chip key={tag} size="sm" variant="soft" color="success"
        className="h-4 min-h-4 shrink-0 rounded bg-emerald-100! px-1 py-0 text-[10px] leading-4 text-emerald-700! dark:bg-emerald-500/20! dark:text-emerald-300!">
        <Chip.Label className="px-0 font-medium">{tag}</Chip.Label>
      </Chip>)}</span>
      {selected ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : null}
    </ToggleButton>

  </div>;
}

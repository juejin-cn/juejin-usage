import { useState } from 'react';
import { Button, ListBox, Select } from '@heroui/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buildEmbedSnippets, EMBED_STYLE_OPTIONS, type EmbedStyle } from '@/lib/embed-usage';

function CardPreview({ url, active, enabled }: { url: string; active: boolean; enabled: boolean }) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  return <div className="flex w-full shrink-0 items-center justify-center p-1" aria-hidden={!active} inert={!active}>
    {failed ? <div role="status" className="space-y-2 text-center text-sm text-muted">
      <p>暂时无法加载预览</p>
      <Button size="sm" variant="tertiary" onPress={() => { setFailed(false); setRetry(value => value + 1); }}>重试预览</Button>
    </div> : <img
      key={retry}
      src={`${url}?v=${retry}`}
      loading={active ? 'eager' : 'lazy'}
      onError={() => setFailed(true)}
      alt={enabled ? '用量卡片实时预览' : '停用后的掘金导流卡预览'}
      className="h-auto w-full"
      referrerPolicy="no-referrer"
    />}
  </div>;
}

export function EmbedUsageCarousel({ apiBase, publicKey, style, enabled, onStyleChange }: {
  apiBase: string;
  publicKey: string;
  style: EmbedStyle;
  enabled: boolean;
  onStyleChange: (style: EmbedStyle) => void;
}) {
  const index = EMBED_STYLE_OPTIONS.findIndex(option => option.id === style);
  const current = EMBED_STYLE_OPTIONS[index]!;

  return <section aria-label="用量卡片预览" aria-roledescription="轮播图" className="min-w-0 space-y-4">
    <Select aria-label="卡片样式" fullWidth variant="secondary" value={style} onChange={value => {
      const option = EMBED_STYLE_OPTIONS.find(option => option.id === value);
      if (option) onStyleChange(option.id);
    }}>
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><ListBox>
        {EMBED_STYLE_OPTIONS.map(option => <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
          {option.label}<ListBox.ItemIndicator />
        </ListBox.Item>)}
      </ListBox></Select.Popover>
    </Select>
    <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2">
      <Button aria-label="上一张卡片" isIconOnly size="sm" variant="tertiary" isDisabled={index === 0} onPress={() => onStyleChange(EMBED_STYLE_OPTIONS[index - 1]!.id)}>
        <ChevronLeft className="size-4" />
      </Button>
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-h-64 transition-transform duration-300 ease-out motion-reduce:transition-none" style={{ transform: `translateX(-${index * 100}%)` }}>
          {EMBED_STYLE_OPTIONS.map((option, cardIndex) => <CardPreview key={option.id}
            url={buildEmbedSnippets(apiBase, publicKey, option.id).url}
            active={cardIndex === index} enabled={enabled}
          />)}
        </div>
      </div>
      <Button aria-label="下一张卡片" isIconOnly size="sm" variant="tertiary" isDisabled={index === EMBED_STYLE_OPTIONS.length - 1} onPress={() => onStyleChange(EMBED_STYLE_OPTIONS[index + 1]!.id)}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
    <p aria-live="polite" aria-atomic="true" className="text-center text-xs text-muted">{current.label} · {index + 1} / {EMBED_STYLE_OPTIONS.length}</p>
  </section>;
}

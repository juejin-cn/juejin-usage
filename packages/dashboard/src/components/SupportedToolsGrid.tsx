import { useState } from 'react';
import { ChevronDown } from '@gravity-ui/icons';
import { Button } from '@heroui/react';
import { ProviderIcon } from '@/components/ProviderIcon';
import {
  SUPPORTED_TOOLS,
  formatSupportedTool,
  type SupportedToolLine,
} from '@/lib/about';
import { cn } from '@/lib/utils';

/**
 * Marks whose official color is the glyph itself, not a flat tile.
 * Hex values follow the brand mark (DeepSeek #4D6BFE, Xiaomi #FF6900,
 * Zed brand blue #1348DC). Full-color SVGs keep their own artwork.
 */
const BRAND_GLYPH_COLOR: Record<string, string> = {
  dsh: '#4D6BFE',
  mimo: '#FF6900',
  zed: '#1348DC',
};

export function SupportedToolsGrid({
  className,
  collapsible = false,
}: {
  className?: string;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const showAll = !collapsible || expanded;

  return (
    <div className="flex flex-col items-stretch">
      {showAll ? (
        <ToolsList className={className} tools={SUPPORTED_TOOLS} />
      ) : (
        <ToolsMarquee />
      )}
      {collapsible ? (
        <Button
          aria-expanded={expanded}
          className="mt-4 self-center"
          onPress={() => setExpanded((open) => !open)}
          size="sm"
          variant="tertiary"
        >
          {expanded
            ? '收起'
            : `查看全部（${SUPPORTED_TOOLS.length}）`}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3.5 transition-transform duration-200 motion-reduce:transition-none',
              expanded && 'rotate-180',
            )}
          />
        </Button>
      ) : null}
    </div>
  );
}

function ToolsList({
  className,
  tools,
}: {
  className?: string;
  tools: readonly SupportedToolLine[];
}) {
  return (
    <ul
      className={cn(
        'grid grid-cols-1 gap-1.5 sm:grid-cols-2',
        'motion-safe:animate-[fade-up_420ms_ease-out]',
        className,
      )}
    >
      {tools.map((tool) => (
        <li
          key={tool.source}
          className="flex items-center gap-2 rounded-lg bg-black/3 px-2.5 py-1.5 text-sm text-foreground/80 dark:bg-white/5"
        >
          <SupportedToolIcon source={tool.source} />
          <span className="min-w-0 leading-snug">
            {formatSupportedTool(tool)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ToolsMarquee() {
  return (
    <div
      aria-hidden="true"
      className="tools-marquee group space-y-1.5 mask-[linear-gradient(to_right,transparent,black_5%,black_95%,transparent)]"
    >
      <MarqueeRow />
      <MarqueeRow reverse />
    </div>
  );
}

function MarqueeRow({ reverse = false }: { reverse?: boolean }) {
  const items = reverse
    ? [...SUPPORTED_TOOLS].reverse()
    : SUPPORTED_TOOLS;

  return (
    <div className="overflow-hidden">
      <div
        className={cn(
          'flex w-max',
          reverse
            ? 'tools-marquee-track-reverse motion-safe:animate-[tools-marquee-reverse_48s_linear_infinite]'
            : 'tools-marquee-track motion-safe:animate-[tools-marquee_40s_linear_infinite]',
          'motion-reduce:animate-none',
        )}
      >
        <MarqueeChunk items={items} />
        <MarqueeChunk items={items} />
      </div>
    </div>
  );
}

function MarqueeChunk({ items }: { items: readonly SupportedToolLine[] }) {
  return (
    <div className="flex shrink-0 gap-1.5 pe-1.5">
      {items.map((tool) => (
        <div
          className="flex shrink-0 items-center gap-2 rounded-lg bg-black/3 px-2.5 py-1.5 text-sm text-foreground/80 dark:bg-white/5"
          key={tool.source}
        >
          <SupportedToolIcon source={tool.source} />
          <span className="leading-snug whitespace-nowrap">{tool.name}</span>
        </div>
      ))}
    </div>
  );
}

function SupportedToolIcon({ source }: { source: string }) {
  const glyph = BRAND_GLYPH_COLOR[source];
  if (glyph) {
    return <ProviderIcon color={glyph} provider={source} size={18} />;
  }

  return <ProviderIcon provider={source} size={18} />;
}

import { SUPPORTED_TOOLS, formatSupportedTool } from '@/lib/about';
import { SupportedToolIcon } from '@/components/SupportedToolsGrid';

const rows = [0, 1].map((row) => SUPPORTED_TOOLS.filter((_, index) => index % 2 === row));

export function ToolLogoMarquee() {
  return (
    <div className="group overflow-hidden mask-[linear-gradient(to_right,transparent,black_5%,black_95%,transparent)] motion-reduce:mask-none space-y-5 py-4" role="group" aria-label="支持的工具" tabIndex={0}>
      {rows.map((tools, row) => (
        <div className="motion-safe:animate-[tools-marquee_120s_linear_infinite] motion-safe:even:[animation-direction:reverse] group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused] motion-reduce:w-full flex w-max" key={row}>
          {[false, true].map((duplicate) => (
            <ul key={String(duplicate)} aria-hidden={duplicate || undefined}
              className="motion-reduce:shrink motion-reduce:flex-wrap motion-reduce:pe-0! motion-reduce:aria-hidden:hidden flex shrink-0 items-center gap-8 pe-8 sm:gap-12 sm:pe-12">
              {tools.map((tool) => (
                <li key={tool.source} title={formatSupportedTool(tool)}
                  className="flex shrink-0 items-center gap-2.5 whitespace-nowrap text-base font-medium text-muted grayscale transition-[color,filter] hover:text-foreground hover:grayscale-0 sm:text-lg">
                  <SupportedToolIcon source={tool.source} size={26} />
                  <span aria-hidden="true">{tool.name}</span>
                  <span className="sr-only">{formatSupportedTool(tool)}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      ))}
    </div>
  );
}

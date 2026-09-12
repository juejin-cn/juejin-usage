import { Maximize2Icon, Minimize2Icon, MinusIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Custom title-bar controls for frameless Windows / Linux windows.
 * macOS keeps native traffic lights; hide this component there.
 */
export function WindowTitleControls() {
  const platform = window.tud?.platform;
  if (!platform || platform === 'darwin') return null;

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => window.tud.onMaximized(setIsMaximized), []);

  return (
    <div className="desktop-window-no-drag flex h-full shrink-0 items-stretch">
      <button
        type="button"
        aria-label="最小化"
        className="flex h-full w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-black/8 hover:text-foreground active:bg-black/12 dark:hover:bg-white/10 dark:active:bg-white/14"
        onClick={() => window.tud.minimize()}
      >
        <MinusIcon className="size-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? '还原窗口' : '最大化'}
        className="flex h-full w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-black/8 hover:text-foreground active:bg-black/12 dark:hover:bg-white/10 dark:active:bg-white/14"
        onClick={() => window.tud.toggleMaximize()}
      >
        {isMaximized ? (
          <Minimize2Icon className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Maximize2Icon className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
      <button
        type="button"
        aria-label="关闭"
        className="flex h-full w-11 items-center justify-center text-foreground/70 transition-colors hover:bg-[#e81123] hover:text-white active:bg-[#c50f1f] active:text-white"
        onClick={() => window.tud.close()}
      >
        <XIcon className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

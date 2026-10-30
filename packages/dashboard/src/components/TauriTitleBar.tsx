import { useEffect, useState } from 'react';
import { Maximize2Icon, Minimize2Icon, MinusIcon, XIcon } from 'lucide-react';
import { getTauriDesktopBridge } from '@/lib/tauri-desktop';

/** Match Electron's chrome, retaining native macOS traffic lights. */
export function TauriTitleBar() {
  const bridge = getTauriDesktopBridge();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => bridge?.onMaximized(setMaximized), [bridge]);
  if (!bridge) return null;
  const run = (action: () => Promise<void>) => {
    void action().catch(() => setError('窗口操作失败，请重试'));
  };
  return <div className="relative z-50 flex h-8 shrink-0 select-none items-stretch bg-transparent text-foreground">
    <div className="min-w-0 flex-1" onMouseDown={event => {
      if (event.button !== 0) return;
      run(event.detail === 2 ? bridge.toggleMaximize : bridge.startDragging);
    }} />
    {error && <span role="alert" className="text-xs">{error}</span>}
    {bridge.platform !== 'darwin' && <div className="flex items-stretch">
      <button type="button" aria-label="最小化" className="w-11 hover:bg-default" onClick={() => run(bridge.minimize)}><MinusIcon className="mx-auto size-3.5" /></button>
      <button type="button" aria-label={maximized ? '还原窗口' : '最大化'} className="w-11 hover:bg-default" onClick={() => run(bridge.toggleMaximize)}>{maximized ? <Minimize2Icon className="mx-auto size-3.5" /> : <Maximize2Icon className="mx-auto size-3.5" />}</button>
      <button type="button" aria-label="关闭" className="w-11 hover:bg-[#e81123] hover:text-white" onClick={() => run(bridge.close)}><XIcon className="mx-auto size-3.5" /></button>
    </div>}
  </div>;
}

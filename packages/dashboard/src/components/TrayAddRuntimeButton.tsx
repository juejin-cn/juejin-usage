import { useEffect, useRef, useState } from 'react';
import { Button, Chip, Popover, Skeleton } from '@heroui/react';
import { Plus } from 'lucide-react';
import { ArrowsRotateRight } from '@gravity-ui/icons';
import type { IntegrationTool } from '@juejin-opensource/jusage-core/agent-router';
import { routerRequest } from '@/lib/agent-router';
import { CLAUDE_RUNTIMES, RUNTIME_TOOLS, type RuntimeView } from '@/lib/gateway-runtimes';
import { ProviderIcon } from './ProviderIcon';

export function TrayAddRuntimeButton({ open, onOpenChange, onSelect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: IntegrationTool) => void;
}) {
  const [view, setView] = useState<RuntimeView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  async function refresh() {
    const current = ++revision.current;
    setLoading(true);
    setError('');
    try {
      const next = await routerRequest<RuntimeView>('/agents/integrations?refresh=1');
      if (current === revision.current) setView(next);
    } catch (cause) {
      if (current === revision.current) setError(cause instanceof Error ? cause.message : '读取运行工具失败');
    } finally {
      if (current === revision.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void refresh();
    return () => { revision.current++; };
  }, [open]);
  return <Popover isOpen={open} onOpenChange={onOpenChange}>
    <Button isIconOnly size="sm" variant="tertiary" className="size-8 min-h-8 min-w-8 shrink-0 p-0" aria-label="添加运行工具"><Plus aria-hidden="true" className="size-4" /></Button>
    <Popover.Content placement="bottom end" className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[10px] p-0">
      <Popover.Dialog className="flex max-h-[min(420px,calc(100vh-2rem))] flex-col gap-1 px-3 pb-3 pt-2 outline-none">
        <div className="flex items-center justify-between gap-2">
          <Popover.Heading className="text-[15px] font-medium">添加运行工具</Popover.Heading>
          <Button isIconOnly size="sm" variant="ghost" className="size-7 min-h-7 min-w-7 p-0" aria-label="刷新工具状态" isDisabled={loading} onPress={() => void refresh()}><ArrowsRotateRight aria-hidden="true" className={`size-4 ${loading ? 'animate-spin' : ''}`} /></Button>
        </div>
        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        <div aria-label="选择运行工具" aria-busy={loading} className="-mr-3 grid min-h-0 gap-1 overflow-y-auto pr-3">
          {loading ? <div role="status" aria-label="正在加载运行工具" className="grid gap-1">
            {RUNTIME_TOOLS.map(id => <div key={id} aria-hidden="true" className="flex h-10 items-center gap-2 px-2">
              <Skeleton className="size-4.5 shrink-0 rounded" />
              <Skeleton className="h-3 w-28 rounded" />
              <Skeleton className="ml-auto h-5 w-12 rounded-full" />
            </div>)}
          </div> : RUNTIME_TOOLS.map(id => {
            const family = view?.tools.filter(tool => id === 'claude' ? CLAUDE_RUNTIMES.some(entry => entry.id === tool.id) : tool.id === id) ?? [];
            const tool = family.find(tool => tool.installed && !tool.enabled) ?? family.find(tool => tool.installed) ?? family.find(tool => tool.enabled) ?? family[0];
            if (!tool) return null;
            const added = family.some(tool => tool.enabled);
            return <Button key={id} variant="ghost" size="sm" className="h-10 w-full justify-start gap-2 rounded-lg px-2 text-foreground" isDisabled={loading || (!tool.installed && !added)} onPress={() => { onOpenChange(false); onSelect(tool.id); }}>
              <ProviderIcon provider={id === 'claude' ? 'claude-code' : tool.icon} size={18} />
              <span className="min-w-0 flex-1 truncate text-left text-sm">{id === 'claude' ? 'Claude Code' : tool.name}</span>
              <Chip size="sm" variant="soft" color={!tool.installed ? added ? 'warning' : 'default' : added ? 'accent' : 'success'} className="shrink-0 text-[11px]">
                <Chip.Label>{!tool.installed ? added ? '已添加 · 未安装' : '未安装' : added ? '已添加' : '已安装'}</Chip.Label>
              </Chip>
            </Button>;
          })}
          {!loading && !error && view && !view.tools.length ? <p className="py-4 text-center text-xs text-muted">暂无可用工具</p> : null}
        </div>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Accordion, Button, Card, Skeleton } from '@heroui/react';
import { ChevronRight } from '@gravity-ui/icons';
import { RefreshCw } from 'lucide-react';
import type { IntegrationChoice, IntegrationStatus, IntegrationTool } from '@juejin-opensource/jusage-core/agent-router';
import { routerRequest } from '@/lib/agent-router';
import { splitVisibleRows } from '@/lib/gateway-grid-visible';
import { useGatewayRuntimeColumns } from '@/hooks/useGatewayGridColumns';
import { compareRuntimeTools, isVisibleRuntimeTool, RUNTIME_STATE_LABELS, type RuntimeView } from '@/lib/gateway-runtimes';
import { GatewayRuntimeModal } from './GatewayRuntimeModal';
import { ProviderIcon } from './ProviderIcon';

function RuntimeToolTile({ tool, view, busy, onOpen }: {
  tool: IntegrationStatus;
  view: RuntimeView;
  busy: boolean;
  onOpen: (id: IntegrationTool) => void;
}) {
  return <div className="flex min-h-20 min-w-0 flex-col justify-between gap-2 rounded-xl bg-surface-secondary p-3">
    <div className="flex min-w-0 items-center gap-2">
      <ProviderIcon provider={tool.icon} size={24} />
      <span className="min-w-0 flex-1 truncate text-sm">{tool.id === 'claude' ? 'Claude Code' : tool.id === 'claude-desktop' ? '桌面端' : tool.name}</span>
      <Button isIconOnly={tool.enabled} size="sm" variant={tool.enabled ? 'ghost' : 'secondary'} className={tool.enabled ? 'size-[26px] min-h-[26px] min-w-[26px] shrink-0 p-0' : 'h-[26px] min-h-[26px] shrink-0 px-2 text-xs'} isDisabled={busy} aria-label={`${tool.enabled ? '配置' : '接入'} ${tool.name}`} onPress={() => onOpen(tool.id)}>{tool.enabled ? <ChevronRight className="size-4 text-muted" /> : '接入'}</Button>
    </div>
    <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
      <span className={`flex shrink-0 items-center gap-1.5 ${tool.state === 'connected' ? 'text-success' : tool.error ? 'text-warning' : 'text-muted'}`}><span className={`size-1.5 rounded-full ${tool.state === 'connected' ? 'bg-success' : tool.error ? 'bg-warning' : 'bg-muted'}`} />{RUNTIME_STATE_LABELS[tool.state]}</span>
      <span className="min-w-0 truncate text-right text-muted" title={tool.defaultModel}>{tool.enabled ? (view.models.find(model => model.id === tool.defaultModel)?.name ?? (tool.defaultModel || '未选择模型')) : null}</span>
    </div>
  </div>;
}

export function GatewayRuntimesCard() {
  const [view, setView] = useState<RuntimeView | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState('');
  const [modalError, setModalError] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<IntegrationTool | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const lock = useRef(false);
  const revision = useRef(0);
  const revealAfter = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const runtimeColumns = useGatewayRuntimeColumns(gridRef);
  const refresh = useCallback(async (fresh = false) => {
    if (lock.current) return;
    const current = ++revision.current;
    if (fresh) setDetecting(true);
    try {
      const next = await routerRequest<RuntimeView>('/agents/integrations' + (fresh ? '?refresh=1' : ''));
      const remaining = revealAfter.current - performance.now();
      if (remaining > 0) await new Promise<void>(resolve => window.setTimeout(resolve, remaining));
      if (active.current && current === revision.current && !lock.current) { setView(next); setError(''); }
    } catch (cause) {
      if (active.current && current === revision.current && !lock.current) setError(cause instanceof Error ? cause.message : '读取工具配置失败');
    } finally { if (active.current && current === revision.current) setDetecting(false); }
  }, []);
  useEffect(() => {
    active.current = true; revealAfter.current = performance.now() + 350;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active.current = false; revision.current++; window.clearInterval(timer); };
  }, [refresh]);

  function select(id: IntegrationTool | null) { setSelected(id); setModalError(''); }
  function close() { if (!lock.current) { setOpen(false); setModalError(''); } }
  function openTool(id: IntegrationTool) { select(id); setOpen(true); void refresh(true); }
  async function update(id: IntegrationTool, choice?: IntegrationChoice) {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(true); setModalError('');
    try {
      const next = await routerRequest<RuntimeView>('/agents/integrations/' + id, {
        method: choice ? 'PUT' : 'DELETE',
        ...(choice ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(choice) } : {}),
      });
      if (active.current) { setView(next); setError(''); setOpen(false); }
    } catch (cause) {
      if (active.current) setModalError(cause instanceof Error ? cause.message : '更新失败，请重试');
    } finally {
      lock.current = false;
      if (active.current) { setBusy(false); setDetecting(false); void refresh(); }
    }
  }
  const tools = [...(view?.tools.filter(isVisibleRuntimeTool) ?? [])].sort(compareRuntimeTools);
  const { visible: visibleTools, rest: moreTools } = splitVisibleRows(tools, runtimeColumns, 1);
  return <>
    <Card className="min-w-0 rounded-2xl" aria-label="运行工具">
      <Card.Header className="flex-row items-center justify-between gap-3">
        <Card.Title>运行工具</Card.Title>
        <Button size="sm" variant="ghost" isDisabled={busy || detecting} aria-busy={detecting} onPress={() => void refresh(true)}><RefreshCw className={`size-4 ${detecting ? 'animate-spin motion-reduce:animate-none' : ''}`} />{detecting ? '检测中…' : '刷新工具'}</Button>
      </Card.Header>
      <Card.Content className="min-w-0">
        {error ? <div role="alert" className="mb-3 flex items-center justify-between gap-2 text-sm text-danger"><span>{error}</span><Button isIconOnly size="sm" variant="ghost" aria-label="重试读取工具状态" isDisabled={busy} onPress={() => void refresh()}><RefreshCw className="size-4" /></Button></div> : null}
        {!view && !error ? <div role="status" aria-label="正在加载工具列表" className="gateway-loading grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2">
          {Array.from({ length: 3 }, (_, index) => <div key={index} aria-hidden="true" className="grid gap-2 rounded-xl p-3"><Skeleton className="size-7 rounded-lg" /><Skeleton className="h-3 w-20 rounded-md" /><Skeleton className="h-3 w-28 max-w-full rounded-md" /></div>)}
        </div> : null}
        <div ref={gridRef} className="min-w-0">
          {visibleTools.length ? <div className="panel-fade-in grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2">
            {visibleTools.map(tool => <RuntimeToolTile key={tool.id} tool={tool} view={view!} busy={busy} onOpen={openTool} />)}
          </div> : null}
          {moreTools.length ? <Accordion hideSeparator defaultExpandedKeys={[]} className={`min-w-0 ${visibleTools.length ? 'mt-2' : ''}`}>
            <Accordion.Item id="more-runtimes">
              <Accordion.Heading>
                <Accordion.Trigger className="gap-2 px-1 py-2 text-sm text-muted hover:bg-transparent">
                  <span className="min-w-0 flex-1 text-left">更多工具 · {moreTools.length}</span>
                  <Accordion.Indicator />
                </Accordion.Trigger>
              </Accordion.Heading>
              <Accordion.Panel>
                <Accordion.Body className="px-0 pt-1">
                  <div className="grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2">
                    {moreTools.map(tool => <RuntimeToolTile key={tool.id} tool={tool} view={view!} busy={busy} onOpen={openTool} />)}
                  </div>
                </Accordion.Body>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion> : null}
        </div>
        {view && !tools.length && !error ? <p className="py-4 text-center text-sm text-muted">未检测到已安装的运行工具</p> : null}
      </Card.Content>
    </Card>
    {open && view ? <GatewayRuntimeModal view={view} selected={selected} busy={busy} detecting={detecting} error={modalError || error} onSelect={select} onClose={close} onRefresh={() => void refresh(true)} onSave={update} onRemove={id => update(id)} /> : null}
  </>;
}

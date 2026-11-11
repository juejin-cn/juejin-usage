import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Skeleton } from '@heroui/react';
import { ChevronDown, ChevronUp, TriangleAlert } from 'lucide-react';
import type { IntegrationChoice, IntegrationStatus, IntegrationTool } from '@juejin-opensource/jusage-core/agent-router';
import { routerErrorMessage, routerRequest } from '@/lib/agent-router';
import { isRuntimeTool, runtimeChoice, runtimeQuickSwitchError, RUNTIME_STATE_LABELS, type RuntimeView } from '@/lib/gateway-runtimes';
import { ProviderIcon } from './ProviderIcon';
import { TrayRuntimeModelPicker } from './TrayRuntimeModelPicker';
import { GatewayRuntimeModal } from './GatewayRuntimeModal';

/** Compact runtime cards with an inline configuration panel and model popover. */
export type TrayGatewayStatus = 'loading' | 'running' | 'stopped' | 'error';

export function TrayGatewayRuntimes({ onStatusChange, onPickerOpenChange, addOpen, onAddOpenChange, initialTool, onChooseTool }: {
  initialTool: IntegrationTool | null;
  onChooseTool: () => void;
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  onStatusChange: (status: TrayGatewayStatus) => void;
  onPickerOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState<IntegrationTool | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [modalError, setModalError] = useState('');
  const adding = useRef(addOpen);
  const [view, setView] = useState<RuntimeView | null>(null);
  const [expanded, setExpanded] = useState<IntegrationTool | null>(null);
  useEffect(() => () => onPickerOpenChange(false), [onPickerOpenChange]);
  const [saving, setSaving] = useState<IntegrationTool | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    onStatusChange(error ? 'error' : !view ? 'loading' : view.running ? 'running' : 'stopped');
  }, [error, view, onStatusChange]);

  const active = useRef(false);
  const locked = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async (fresh = false) => {
    if (!fresh && adding.current) return;
    if (locked.current || document.visibilityState === 'hidden') return;
    const current = ++revision.current;
    if (fresh) setDetecting(true);
    try {
      const next = await routerRequest<RuntimeView>('/agents/integrations' + (fresh ? '?refresh=1' : ''));
      if (active.current && current === revision.current) {
        setView(next);
        setError('');
      }
    } catch (cause) {
      if (active.current && current === revision.current) {
        setError(cause instanceof Error ? cause.message : '读取运行工具失败');
      }
    } finally {
      if (active.current && fresh) setDetecting(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onVisible = () => void refresh();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active.current = false;
      revision.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    adding.current = addOpen;
    if (addOpen) {
      setSelected(initialTool);
      setModalError('');
      void refresh(true);
    }
  }, [addOpen, initialTool, refresh]);

  async function updateIntegration(id: IntegrationTool, choice?: IntegrationChoice) {
    if (locked.current) return;
    locked.current = true;
    revision.current++;
    setSaving(id);
    setModalError('');
    try {
      const next = await routerRequest<RuntimeView>('/agents/integrations/' + id, {
        method: choice ? 'PUT' : 'DELETE',
        ...(choice ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(choice) } : {}),
      });
      if (active.current) {
        setView(next);
        setError('');
        setSaveError('');
        onAddOpenChange(false);
      }
    } catch (cause) {
      if (active.current) setModalError(cause instanceof Error ? cause.message : '更新运行工具失败，请重试');
    } finally {
      locked.current = false;
      if (active.current) setSaving(null);
    }
  }

  async function changeModel(tool: IntegrationStatus, modelId: string) {
    if (!view || locked.current) return;
    const choice = { ...runtimeChoice(tool, view.models), defaultModel: modelId };
    if (runtimeQuickSwitchError(view, tool, modelId)) return;
    locked.current = true;
    revision.current++;
    setSaving(tool.id);
    setError('');
    setNotice('');
    setSaveError('');
    try {
      const next = await routerRequest<RuntimeView>('/agents/integrations/' + tool.id, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choice),
      });
      if (active.current) {
        setView(next);
        setNotice(`${tool.name} 默认模型已更新，请重新加载配置或开启新会话。`);
      }
    } catch (cause) {
      if (active.current) setSaveError(cause instanceof Error ? cause.message : '切换模型失败，请重试');
    } finally {
      locked.current = false;
      if (active.current) setSaving(null);
    }
  }

  const tools = view?.tools.filter(tool => tool.enabled && isRuntimeTool(tool.id)) ?? [];
  return <section aria-label="网关运行工具" className="grid gap-2.5">
    {error || saveError ? <p role="alert" className="break-words text-xs text-danger">{saveError || error}</p> : null}
    {notice ? <p role="status" className="text-xs text-muted">{notice}</p> : null}
    {!view && !error ? <div role="status" aria-label="正在加载运行工具" className="grid gap-3">
      {[0, 1, 2].map(index => <div key={index} className="flex items-center gap-3 p-3"><Skeleton className="size-7 rounded-lg" /><Skeleton className="h-3 w-24 rounded" /></div>)}
    </div> : null}
    {view && !tools.length ? <p className="py-8 text-center text-xs text-muted">暂无接入的运行工具，点击右上角添加工具。</p> : null}
    {view ? tools.map(tool => {
      const choice = runtimeChoice(tool, view.models);
      const models = view.models.filter(model => choice.models.includes(model.id));
      const currentModel = view.models.find(model => model.id === tool.defaultModel || model.legacyId === tool.defaultModel);
      const isExpanded = expanded === tool.id;
      const disabledReason = runtimeQuickSwitchError(view, tool, choice.defaultModel);
      return <Card key={tool.id} className="min-w-0 self-start overflow-hidden rounded-2xl px-3 py-2" aria-busy={saving === tool.id}>
        <Card.Content className="grid gap-0 p-0">
          <Button variant="ghost"
            aria-expanded={isExpanded} aria-controls={`tray-runtime-${tool.id}`}
            aria-label={`${isExpanded ? '收起' : '展开'} ${tool.name} 模型配置`}
            className="h-auto min-h-7 w-full min-w-0 justify-start gap-2 rounded-lg bg-transparent! transform-none! p-0 text-left text-foreground"
            onPress={() => { onPickerOpenChange(false); setExpanded(isExpanded ? null : tool.id); }}>
            <ProviderIcon provider={tool.icon} size={20} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{tool.id === 'claude' ? 'Claude Code · 终端' : tool.name}</span>
            <span className={`flex shrink-0 items-center gap-1 text-xs ${tool.state === 'connected' ? 'text-success' : tool.state === 'conflict' ? 'text-warning' : 'text-muted'}`}>
              {tool.state === 'conflict' ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : null}
              {RUNTIME_STATE_LABELS[tool.state]}
            </span>
            <span className="flex size-7 shrink-0 items-center justify-center">
              {isExpanded ? <ChevronUp aria-hidden="true" className="size-4 text-muted" /> : <ChevronDown aria-hidden="true" className="size-4 text-muted" />}
            </span>
          </Button>
          <div id={`tray-runtime-${tool.id}`} aria-hidden={!isExpanded} inert={!isExpanded}
            className={`grid motion-safe:transition-[grid-template-rows,opacity,margin-top] motion-safe:duration-250 motion-safe:ease-out ${isExpanded ? 'mt-3 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'}`}>
            <div className="min-h-0 overflow-hidden">
              <div className="grid gap-2 pb-2">
                {disabledReason || tool.error ? <p className="text-xs text-warning">{disabledReason || routerErrorMessage(tool.error!)}</p> : null}
                {isExpanded ? <TrayRuntimeModelPicker
                  models={models} currentModel={currentModel}
                  disabled={Boolean(saving) || Boolean(disabledReason) || !models.length}
                  saving={saving === tool.id} onOpenChange={onPickerOpenChange}
                  onChange={id => void changeModel(tool, id)}
                /> : null}
              </div>
            </div>
          </div>
        </Card.Content>
      </Card>;
    }) : null}
    {addOpen ? <GatewayRuntimeModal
      view={view ?? { tools: [], models: [], running: false, baseUrl: null }}
      selected={selected} busy={Boolean(saving)} detecting={detecting} error={modalError || error}
      onSelect={id => { if (id === null) onChooseTool(); else setSelected(id); setModalError(''); }}
      onClose={() => { if (!locked.current) onAddOpenChange(false); }}
      onRefresh={() => void refresh(true)} onSave={updateIntegration} onRemove={id => updateIntegration(id)}
    /> : null}
  </section>;
}

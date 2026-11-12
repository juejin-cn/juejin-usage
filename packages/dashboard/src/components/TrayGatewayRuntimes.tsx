import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Accordion, Button, Skeleton, Switch } from '@heroui/react';
import { TriangleAlert } from 'lucide-react';
import type { IntegrationChoice, IntegrationTool } from '@juejin-opensource/jusage-core/agent-router';
import { routerRequest } from '@/lib/agent-router';
import { compareRuntimeToolPriority, compareRuntimeTools, isRuntimeTool, runtimeChoice, runtimeSelectionError, runtimeQuickSwitchError, RUNTIME_STATE_LABELS, type RuntimeView } from '@/lib/gateway-runtimes';
import { ProviderIcon } from './ProviderIcon';
import { TrayRuntimeModelPicker } from './TrayRuntimeModelPicker';
import { GatewayRuntimeModal } from './GatewayRuntimeModal';

/** Grouped runtime connections with inline configuration. */
export type TrayGatewayStatus = 'loading' | 'running' | 'stopped' | 'error';

export function TrayGatewayRuntimes({ onStatusChange, onPickerOpenChange, addOpen, onAddOpenChange, initialTool, onConnectTool }: {
  initialTool: IntegrationTool | null;
  onConnectTool: (id: IntegrationTool) => void;
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
  const [displayOrder, setDisplayOrder] = useState<IntegrationTool[]>([]);
  const [expanded, setExpanded] = useState<IntegrationTool | null>(null);
  useEffect(() => () => onPickerOpenChange(false), [onPickerOpenChange]);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const lastSnapshot = useRef('');
  const [saving, setSaving] = useState<IntegrationTool | null>(null);
  const [error, setError] = useState('');
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
        const snapshot = JSON.stringify(next);
        if (snapshot !== lastSnapshot.current) {
          lastSnapshot.current = snapshot;
          setView(next);
        }
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

  async function updateIntegration(id: IntegrationTool, choice?: IntegrationChoice, inline = false) {
    if (locked.current) return;
    locked.current = true;
    revision.current++;
    setSaving(id);
    setPendingEnabled(Boolean(choice));
    setModalError('');
    setSaveError('');
    if (inline) onPickerOpenChange(false);
    try {
      const next = await routerRequest<RuntimeView>('/agents/integrations/' + id, {
        method: choice ? 'PUT' : 'DELETE',
        ...(choice ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(choice) } : {}),
      });
      if (active.current) {
        const snapshot = JSON.stringify(next);
        if (snapshot !== lastSnapshot.current) {
          lastSnapshot.current = snapshot;
          setView(next);
        }
        setError('');
        setSaveError('');
        onAddOpenChange(false);
        if (inline) {
          setExpanded(id);
        }
      }
    } catch (cause) {
      if (active.current) (inline ? setSaveError : setModalError)(cause instanceof Error ? cause.message : '更新运行工具失败，请重试');
    } finally {
      locked.current = false;
      if (active.current) { setSaving(null); setPendingEnabled(null); }
    }
  }

  const expandedSettings = useMemo(() => {
    const tool = view?.tools.find(tool => tool.id === expanded);
    if (!view || !tool) return null;
    const choice = runtimeChoice(tool, view.models);
    const selectedIds = new Set(choice.models);
    const models = view.models.filter(model => selectedIds.has(model.id));
    return { choice, models, disabledReason: tool.enabled ? runtimeQuickSwitchError(view, tool, choice.defaultModel) : null };
  }, [view, expanded]);

  const tools = view?.tools.filter(tool => isRuntimeTool(tool.id)) ?? [];
  const installedTools = tools.filter(tool => tool.installed).sort((a, b) => {
    if (expanded && displayOrder.length) {
      const rank = (id: IntegrationTool) => { const index = displayOrder.indexOf(id); return index < 0 ? displayOrder.length : index; };
      return rank(a.id) - rank(b.id);
    }
    return compareRuntimeTools(a, b);
  });
  const missingTools = tools.filter(tool => !tool.installed).sort((a, b) => compareRuntimeToolPriority(a.id, b.id));
  return <section aria-label="网关运行工具" className="grid gap-2.5">
    {error || saveError ? <p role="alert" className="break-words text-xs text-danger">{saveError || error}</p> : null}
    {!view && !error ? <div role="status" aria-label="正在加载运行工具" className="grid gap-3">
      {[0, 1, 2].map(index => <div key={index} className="flex items-center gap-3 p-3"><Skeleton className="size-7 rounded-lg" /><Skeleton className="h-3 w-24 rounded" /></div>)}
    </div> : null}
    {view && !installedTools.length ? <p className="py-8 text-center text-xs text-muted">未检测到已安装的运行工具，可在右上角刷新检测。</p> : null}
    {view && installedTools.length ? <Accordion aria-label="已安装的运行工具" variant="surface" className="min-w-0 [--radius-3xl:10px]" expandedKeys={expanded && installedTools.some(tool => tool.id === expanded) ? [expanded] : []}
      onExpandedChange={keys => {
        onPickerOpenChange(false);
        const next = installedTools.find(tool => keys.has(tool.id))?.id ?? null;
        setDisplayOrder(next ? installedTools.map(tool => tool.id) : []);
        setExpanded(next);
      }}>
      {installedTools.map(tool => {
      const isExpanded = expanded === tool.id;
      return <Accordion.Item key={tool.id} id={tool.id} className="min-w-0" aria-busy={saving === tool.id}>
        <Accordion.Heading>
          <Accordion.Trigger aria-label={`${isExpanded ? '收起' : '展开'} ${tool.name} 模型配置`}
            className="min-w-0 gap-2 py-3 pr-3 text-left text-foreground hover:bg-transparent data-[hovered=true]:bg-transparent">
            <ProviderIcon provider={tool.icon} size={20} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{tool.id === 'claude' ? 'Claude Code' : tool.id === 'claude-desktop' ? '桌面端' : tool.name}</span>
            <span className={`flex shrink-0 items-center gap-1 text-xs ${tool.state === 'connected' ? 'text-success' : tool.state === 'conflict' ? 'text-warning' : 'text-muted'}`}>
              {tool.state === 'conflict' ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : null}
              {RUNTIME_STATE_LABELS[tool.state]}
            </span>
            <Accordion.Indicator />
          </Accordion.Trigger>
        </Accordion.Heading>
        <Accordion.Panel className="transition-none">
          {isExpanded && expandedSettings ? <Accordion.Body className="grid min-w-0 gap-3 pb-3 pt-1">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted">使用代理</span>
              {tool.id === 'claude-desktop' ? <Button size="sm" variant="secondary" onPress={() => onConnectTool(tool.id)} isDisabled={Boolean(saving)}>配置引导</Button> : <Switch size="md" aria-label={`${tool.name} 使用代理`}
                isSelected={saving === tool.id && pendingEnabled !== null ? pendingEnabled : tool.enabled} isDisabled={Boolean(saving)} aria-busy={saving === tool.id}
                onChange={enabled => {
                  setSaveError('');
                  if (enabled) {
                    const reason = runtimeSelectionError(view, tool, expandedSettings.choice);
                    if (reason) { setSaveError(reason); return; }
                  }
                  void updateIntegration(tool.id, enabled ? expandedSettings.choice : undefined, true);
                }}>
                <Switch.Content>
                  <Switch.Control className="h-[24px] w-[44px] rounded-full"><Switch.Thumb className="ms-[3px] size-[18px] rounded-full [--switch-thumb-offset:calc(100%_-_24px)]" /></Switch.Control>
                </Switch.Content>
              </Switch>}
            </div>
            {isExpanded && tool.enabled && tool.capability === 'automatic' ? <TrayRuntimeModelPicker
              models={expandedSettings.models} currentModel={expandedSettings.models.find(model => model.id === expandedSettings.choice.defaultModel)}
              disabled={!tool.enabled || Boolean(saving) || Boolean(expandedSettings.disabledReason) || !expandedSettings.models.length}
              saving={saving === tool.id} onOpenChange={onPickerOpenChange}
              onChange={id => {
                const reason = runtimeQuickSwitchError(view, tool, id);
                if (reason) { setSaveError(reason); return; }
                void updateIntegration(tool.id, { ...expandedSettings.choice, defaultModel: id }, true);
              }}
            /> : null}
          </Accordion.Body> : null}
        </Accordion.Panel>
      </Accordion.Item>;
    })}
    </Accordion> : null}
    {missingTools.length ? <Accordion hideSeparator defaultExpandedKeys={[]} className="mt-3 min-w-0" aria-label="未安装的运行工具">
      <Accordion.Item id="missing-runtimes">
        <Accordion.Heading>
          <Accordion.Trigger className="gap-2 px-1 py-2 text-sm text-muted hover:bg-transparent">
            <span className="min-w-0 flex-1 text-left">未安装 · {missingTools.length}</span>
            <Accordion.Indicator />
          </Accordion.Trigger>
        </Accordion.Heading>
        <Accordion.Panel>
          <Accordion.Body className="px-0 pt-1">
            <ul className="divide-y divide-separator/50 rounded-[10px] bg-surface px-4">
              {missingTools.map(tool => <li key={tool.id} className="flex min-w-0 items-center gap-2 py-3">
                <ProviderIcon provider={tool.icon} size={20} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted">{tool.id === 'claude' ? 'Claude Code' : tool.id === 'claude-desktop' ? '桌面端' : tool.name}</span>
                <span className="shrink-0 text-xs text-muted">未安装</span>
              </li>)}
            </ul>
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion> : null}
    {addOpen ? <GatewayRuntimeModal showToolList={false}
      view={view ?? { tools: [], models: [], running: false, baseUrl: null }}
      selected={selected} busy={Boolean(saving)} detecting={detecting} error={modalError || error}
      onSelect={id => { if (id === null) onAddOpenChange(false); else setSelected(id); setModalError(''); }}
      onClose={() => { if (!locked.current) onAddOpenChange(false); }}
      onRefresh={() => void refresh(true)} onSave={updateIntegration} onRemove={id => updateIntegration(id)}
    /> : null}
  </section>;
}

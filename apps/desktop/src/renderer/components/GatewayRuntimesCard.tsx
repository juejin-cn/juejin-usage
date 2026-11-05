import { Accordion, Button, Label, ListBox, Select, Card, Spinner, Switch, ToggleButton } from '@heroui/react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IntegrationChoice, IntegrationStatus, ModelOption } from '@juejin-opensource/jusage-core/agent-router';
import { routerErrorMessage, routerRequest } from '@/lib/agent-router';
import { ProviderIcon } from './ProviderIcon';

type View = { tools: IntegrationStatus[]; models: ModelOption[]; running: boolean; baseUrl: string | null };
const labels: Record<IntegrationStatus['state'], string> = {
  connected: '已接入', stopped: '网关未启动', unconfigured: '未设置', missing: '未安装', manual: '手动配置', unsupported: '不支持自定义网关', conflict: '配置冲突', pending: '配置待同步',
};
export function GatewayRuntimesCard() {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, IntegrationChoice>>({});
  const [copied, setCopied] = useState('');
  const lock = useRef(false); const active = useRef(false); const revision = useRef(0);
  const refresh = useCallback(async () => {
    if (lock.current) return;
    const current = ++revision.current;
    try { const result = await routerRequest<View>('/agents/integrations'); if (active.current && revision.current === current) setView(result); }
    catch (cause) { if (active.current && revision.current === current) setError(cause instanceof Error ? cause.message : '读取工具配置失败'); }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { active.current = false; revision.current++; clearInterval(timer); };
  }, [refresh]);
  const change = async (tool: IntegrationStatus, choice?: IntegrationChoice) => {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(tool.id); setError('');
    try {
      const result = await routerRequest<View>('/agents/integrations/' + tool.id, { method: choice ? 'PUT' : 'DELETE', headers: { 'content-type': 'application/json' }, ...(choice ? { body: JSON.stringify(choice) } : {}) });
      if (active.current) { setView(result); setDrafts(previous => { const next = { ...previous }; delete next[tool.id]; return next; }); }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '更新失败，请重试'); }
    finally { lock.current = false; if (active.current) { setBusy(null); void refresh(); } }
  };
  const choose = (tool: IntegrationStatus, choice: IntegrationChoice) => {
    if (tool.enabled) void change(tool, choice); else setDrafts(previous => ({ ...previous, [tool.id]: choice }));
  };
  const copy = async (key: string, value?: string) => {
    try {
      const text = key === 'token' ? (await routerRequest<{ token: string }>('/token')).token : value ?? '';
      await navigator.clipboard.writeText(text); if (active.current) setCopied(key);
    } catch { setError('复制失败，请确认网关已启动及剪贴板权限。'); }
  };
  const groups = view ? [
    { label: '已接入', tools: view.tools.filter(tool => tool.enabled) },
    { label: '未设置', tools: view.tools.filter(tool => !tool.enabled && tool.installed) },
    { label: '未安装', tools: view.tools.filter(tool => !tool.enabled && !tool.installed) },
  ] : [];
  return <Card className="min-w-0 rounded-2xl" aria-label="Runtimes">
    <Card.Header className="flex-row items-center justify-between gap-3">
      <Card.Title>Runtimes</Card.Title>
      <Button isIconOnly size="sm" variant="ghost" className="size-7 min-w-7 p-0" aria-label="刷新工具状态" isDisabled={!!busy} onPress={() => void refresh()}><RefreshCw className="size-4" /></Button>
    </Card.Header>
    <Card.Content className="min-w-0">
        {error ? <p role="alert" className="mb-3 text-sm text-danger">{error}</p> : null}
        {view && !view.running ? <p className="mb-3 text-sm text-warning">网关未启动，启动后可接入或更新配置。已接入工具的配置会保留。</p> : null}
        {!view ? <Spinner size="sm" aria-label="读取工具列表" /> : groups.filter(group => group.tools.length).map(group => <section key={group.label} className="mb-5">
          <Label className="mb-2 block text-sm text-muted">{group.label}</Label>
          <Accordion allowsMultipleExpanded hideSeparator className="gap-2.5">
            {group.tools.map(tool => {
              const selected = drafts[tool.id] ?? { mode: tool.mode, models: tool.models, defaultModel: tool.defaultModel };
              const ids = selected.mode === 'all' ? view.models.map(model => model.id) : selected.models.filter(id => view.models.some(model => model.id === id));
              const defaultModel = ids.includes(selected.defaultModel) ? selected.defaultModel : ids[0] ?? '';
              const choice = { ...selected, models: ids, defaultModel };
              const disabled = !!busy || !view.running || !tool.installed;
              return <Accordion.Item key={tool.id} id={tool.id} className="overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-xs">
                <Accordion.Heading><Accordion.Trigger className="gap-3 px-4 py-4 hover:bg-transparent data-[hovered=true]:bg-transparent">
                  <ProviderIcon provider={tool.icon} size={28} /><span className="ml-2 min-w-0 flex-1 text-left">{tool.name}</span>
                  <span className={`mr-2 text-xs font-normal ${tool.error ? 'text-warning' : 'text-muted'}`}>{busy === tool.id ? '更新中…' : tool.enabled && tool.state === 'connected' ? `${ids.length} / ${view.models.length} 个模型` : labels[tool.state]}</span>
                  <Accordion.Indicator />
                </Accordion.Trigger></Accordion.Heading>
                <Accordion.Panel><Accordion.Body className="grid gap-3 px-4 pt-2 pb-4">
                  {tool.error ? <p role="alert" className="text-xs text-warning">{routerErrorMessage(tool.error)}</p> : null}
                  {tool.capability === 'automatic' ? <>
                    <div className="flex items-center justify-between gap-3"><div className="text-sm"><span className="font-medium">jusage</span><span className="ml-2 text-muted">{labels[tool.state]}</span></div>
                      <Switch aria-label={`将 ${tool.name} 接入网关`} isSelected={tool.enabled} isDisabled={!!busy || (!tool.enabled && (disabled || !ids.length))} onChange={enabled => void change(tool, enabled ? choice : undefined)}>
                        <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content>
                      </Switch>
                    </div>
                    <div className="flex items-center justify-between rounded-lg bg-surface-secondary px-3 py-2 text-sm"><span className="text-muted">供应商</span><span>jusage</span></div>
                    <Select aria-label={`${tool.name} 默认模型`} value={defaultModel || null} isDisabled={disabled || !ids.length} onChange={value => { if (value !== null) choose(tool, { ...choice, defaultModel: String(value) }); }}>
                      <Label>默认模型</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                      <Select.Popover><ListBox>{view.models.filter(model => ids.includes(model.id)).map(model => <ListBox.Item key={model.id} id={model.id} textValue={`${model.name} · ${model.provider}`}><span>{model.name}<span className="ml-2 text-xs text-muted">{model.provider}</span></span><ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
                    </Select>
                    <details className="rounded-lg border border-border px-3 py-2">
                      <summary className="cursor-pointer text-sm">模型 · {selected.mode === 'all' ? '全部跟随' : '自定义'} · 显示 {ids.length} / {view.models.length} 个模型</summary>
                      <div className="mt-3 flex items-center justify-between"><span className="text-xs text-muted">仅控制工具的模型菜单</span><Button size="sm" variant="tertiary" isDisabled={disabled || selected.mode === 'all'} onPress={() => choose(tool, { mode: 'all', models: view.models.map(m => m.id), defaultModel })}>恢复全部</Button></div>
                      {[...new Set(view.models.map(model => model.provider))].map(provider => <div key={provider} className="mt-3"><p className="mb-2 text-xs text-muted">{provider}</p><div className="flex flex-wrap gap-1.5">{view.models.filter(m => m.provider === provider).map(model => <ToggleButton key={model.id} size="sm" className="h-7 min-h-7 px-2 text-xs data-[pressed=true]:scale-100" isSelected={ids.includes(model.id)} isDisabled={disabled || (ids.length === 1 && ids.includes(model.id))} onChange={on => {
                        const models = on ? [...ids, model.id] : ids.filter(id => id !== model.id); choose(tool, { mode: 'custom', models, defaultModel: models.includes(defaultModel) ? defaultModel : models[0] ?? '' });
                      }}><span title={model.id}>{model.name}</span>{ids.includes(model.id) ? <Check className="size-3" /> : null}</ToggleButton>)}</div></div>)}
                      {!view.models.length ? <p className="mt-2 text-xs text-muted">暂无已开放且可用的模型。</p> : null}
                    </details>
                    <p className="text-xs text-muted">关闭接入会撤销仍由本工具管理的配置，并保留外部修改。修改后请在工具中重新加载配置或重启工具。{tool.id === 'claude' ? '旧版 Claude Code 可能只支持默认模型，请更新后使用完整模型菜单。' : ''}</p>
                    {tool.state === 'pending' && tool.enabled ? <Button size="sm" variant="tertiary" isDisabled={disabled || !ids.length} onPress={() => void change(tool, choice)}>重试同步</Button> : null}
                    {tool.state === 'conflict' ? <p className="text-xs text-warning">检测到外部修改，自动同步已暂停。仍可关闭接入，关闭时会保留这些修改。</p> : null}
                    {tool.error && !tool.enabled ? <Button size="sm" variant="tertiary" isDisabled={!!busy} onPress={() => void change(tool)}>重试清理</Button> : null}
                  </> : tool.capability === 'unsupported' ? <p className="text-sm text-muted">Cursor CLI 使用 Cursor 自身的模型服务，目前不支持将此自定义网关作为模型提供方。可改用 OpenCode、Claude Code 或 Codex。</p> : <>
                    <p className="text-sm text-muted">{tool.id === 'cursor-ide' ? '在 Cursor 设置 → Models 中配置 API Key 和自定义 Base URL。普通 Cursor 的请求可能经过远端服务，本机 127.0.0.1 地址不能用于远端请求；本功能不创建公网隧道。' : '在 Trae 设置 → 模型中添加自定义模型，选择 OpenAI Chat Completions。下方提供完整接口地址；如果使用 Base URL 模式，请使用网关根地址。'}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="tertiary" isDisabled={!view.running || !view.baseUrl} onPress={() => void copy('base', tool.id === 'trae' ? view.baseUrl!.replace(/\/v1$/, '') : view.baseUrl!)}>{copied === 'base' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}复制 Base URL</Button>
                      {tool.id === 'trae' ? <Button size="sm" variant="tertiary" isDisabled={!view.running || !view.baseUrl} onPress={() => void copy('endpoint', view.baseUrl + '/chat/completions')}>复制完整接口地址</Button> : null}
                      <Button size="sm" variant="tertiary" isDisabled={!view.running} onPress={() => void copy('token')}>{copied === 'token' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}复制 API Key</Button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">{view.models.map(model => <Button key={model.id} size="sm" variant="tertiary" onPress={() => void copy(model.id, model.id)}><span title={model.id}>{model.name}</span>{copied === model.id ? <Check className="size-3" /> : <Copy className="size-3" />}</Button>)}</div>
                    <p className="text-xs text-muted">复制参数不代表已接入，请在目标工具中完成配置并验证。</p>
                  </>}
                </Accordion.Body></Accordion.Panel>
              </Accordion.Item>;
            })}
          </Accordion>
        </section>)}
    </Card.Content>
  </Card>;
}

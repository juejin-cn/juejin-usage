import { useGatewayModelNames } from '@/lib/gateway-model-names';
import { channelKey, groupChannels, isVisibleGatewayProvider } from '@/lib/gateway-channels';
import { gatewayToolName } from '@/lib/gateway-onboarding';
import { ROUTER_PRESETS } from '@juejin-opensource/jusage-core/agent-router/presets';
import { ProviderIcon } from './ProviderIcon';
import { Accordion, Button, Description, Form, Label, Card, NumberField, Popover, Switch, Tabs, ToggleButton } from '@heroui/react';
import { Key, Link } from '@gravity-ui/icons';
import { Check, Copy, Eye, EyeOff, Pencil, RotateCcw, Zap } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { saveRouter, routerRequest, type AgentRouterSnapshot } from '@/lib/agent-router';
import type { Protocol } from '@juejin-opensource/jusage-core/agent-router';

const apis = {
  chat: { label: 'OpenAI' },
  responses: { label: 'Responses' },
  messages: { label: 'Anthropic' },
  gemini: { label: 'Gemini' },
};
const MIN_PORT = 1024;
const MAX_PORT = 65535;

export function GatewayConnectionCard({ snapshot, onRefresh, busy, onSaveNetwork, onTest }: {
  snapshot: AgentRouterSnapshot | null; onRefresh: () => Promise<unknown>;
  busy: boolean; onSaveNetwork: (settings: { port: number; lan: boolean }) => Promise<void>; onTest: () => void;
}) {
  const savedPort = snapshot?.port || snapshot?.config.port || 18453;
  const lan = Boolean(snapshot?.config.lan);
  const [editingPort, setEditingPort] = useState(false);
  const [port, setPort] = useState(savedPort);
  useEffect(() => { setPort(savedPort); }, [savedPort]);
  const portValid = Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
  async function savePort() {
    if (port === savedPort) { setEditingPort(false); return; }
    await onSaveNetwork({ port, lan });
    setEditingPort(false);
  }
  const fieldId = useId();
  const [modelDrafts, setModelDrafts] = useState<Record<string, Record<string, boolean>>>({});
  const [savingModels, setSavingModels] = useState(false);
  const savingModelsRef = useRef(false);
  const pendingModels = useRef<Record<string, Record<string, boolean>>>({});
  const tokenRevision = useRef(0);
  const [resetting, setResetting] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('chat');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const running = snapshot?.phase === 'running';
  const channels = groupChannels(snapshot?.config.providers.filter(p => p.enabled && isVisibleGatewayProvider(p)) ?? []);
  const modelNames = useGatewayModelNames(channels.flat(), snapshot);
  useEffect(() => {
    tokenRevision.current++;
    setResetting(false);
    setModelDrafts({});
    let disposed = false;
    setToken(''); setError('');
    routerRequest<{ token: string }>('/token').then(result => { if (!disposed) setToken(result.token); })
      .catch(() => { if (!disposed) setError('无法读取访问令牌，请稍后重试。'); });
    return () => { disposed = true; tokenRevision.current++; };
  }, [running]);
  const base = snapshot?.baseUrl ?? `http://127.0.0.1:${snapshot?.config.port ?? 18453}/v1`;
  const anthropic = protocol === 'messages';
  const gemini = protocol === 'gemini';
  const baseUrl = anthropic || gemini ? base.replace(/\/v1$/, '') : base;
  const lanUrls = (snapshot?.lanUrls ?? []).map(url => anthropic || gemini ? url.replace(/\/v1$/, '') : url);
  const baseVariable = gemini ? 'GOOGLE_GEMINI_BASE_URL' : anthropic ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL';
  const keyName = gemini ? 'GEMINI_API_KEY' : anthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  async function copy(id: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(id); setError(''); }
    catch { setError('复制失败，请检查剪贴板权限。'); }
  }
  function selectModel(channel: string, model: string, selected: boolean) {
    pendingModels.current = {
      ...pendingModels.current,
      [channel]: { ...pendingModels.current[channel], [model]: selected },
    };
    setModelDrafts(previous => ({ ...previous, [channel]: { ...previous[channel], [model]: selected } }));
    void syncModels();
  }
  async function syncModels() {
    if (savingModelsRef.current) return;
    savingModelsRef.current = true; setSavingModels(true); setError('');
    try {
      // Serialize writes and merge every batch into the latest configuration.
      // New clicks remain optimistic while the preceding request is in flight.
      while (Object.keys(pendingModels.current).length) {
        const drafts = pendingModels.current;
        pendingModels.current = {};
        const latest = await routerRequest<AgentRouterSnapshot>();
        const providers = latest.config.providers.map(provider => {
          const draft = drafts[channelKey(provider)];
          if (!draft || !provider.enabled) return provider;
          const excludedModels = provider.models.filter(model =>
            Object.hasOwn(draft, model) ? !draft[model] : provider.excludedModels?.includes(model));
          return { ...provider, excludedModels };
        });
        if (JSON.stringify(providers) !== JSON.stringify(latest.config.providers)) {
          await saveRouter({ ...latest.config, providers });
        }
        await onRefresh();
      }
    } catch (error) {
      pendingModels.current = {};
      setError(error instanceof Error ? error.message : '更新模型失败，请重试。');
      try { await onRefresh(); } catch { /* Keep the last confirmed snapshot. */ }
      // Discard changes made while recovering from the failed write as well.
      pendingModels.current = {};
    } finally {
      setModelDrafts({});
      savingModelsRef.current = false; setSavingModels(false);
    }
  }
  async function resetAccessToken() {
    if (resetting) return;
    const revision = tokenRevision.current;
    setResetting(true); setError(''); setCopied('');
    try {
      await routerRequest('/token/rotate', { method: 'POST' });
      if (revision !== tokenRevision.current) return;
      setToken(''); setShowToken(false);
      const result = await routerRequest<{ token: string }>('/token');
      if (revision === tokenRevision.current) setToken(result.token);
    } catch (error) {
      if (revision === tokenRevision.current) setError(error instanceof Error ? error.message : '重置密钥失败，请稍后重试。');
    } finally {
      if (revision === tokenRevision.current) setResetting(false);
    }
  }
  return <Card className="min-w-0 rounded-2xl" aria-label="网关配置" aria-busy={savingModels}>
    <Card.Header className="flex-row flex-wrap items-center justify-between gap-3">
      <Card.Title>网关配置</Card.Title>
      <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full px-3 text-xs" isDisabled={!running || busy} onPress={onTest}>
        <Zap aria-hidden="true" className="size-3.5" />测试
      </Button>
      <Tabs
        className="ml-auto w-fit shrink-0 text-center"
        selectedKey={protocol}
        onSelectionChange={key => setProtocol(key as Protocol)}
      >
        <Tabs.ListContainer>
          <Tabs.List
            aria-label="接入协议"
            className="w-fit *:h-6 *:w-fit *:px-3 *:text-sm *:font-normal *:transition-none! *:data-[selected=true]:text-accent-foreground"
          >
            {(Object.keys(apis) as Protocol[]).map(key => (
              <Tabs.Tab className="transition-none!" id={key} key={key}>
                <span className="text-xs font-normal">{apis[key].label}</span>
                <Tabs.Indicator className="bg-accent transition-none!" />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
    </Card.Header>
    <Card.Content className="grid min-w-0 gap-4">
        {!running ? <p className="text-[13px] text-warning">网关未启动，启动后可使用以下配置。</p> : null}
        {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
        <Form className="flex min-w-0 flex-col gap-4" onSubmit={event => event.preventDefault()}>
          <div className="grid min-w-0 gap-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <Label className="inline-flex items-center gap-1.5" htmlFor={`${fieldId}-Base-URL`}><Link aria-hidden="true" className="size-4 shrink-0" />Base URL</Label>
              <Switch size="sm" isSelected={lan} isDisabled={busy} onChange={value => void onSaveNetwork({ port: savedPort, lan: value })}>
                <Switch.Content className="gap-1.5 text-xs font-normal text-muted">
                  <Switch.Control><Switch.Thumb /></Switch.Control>
                  局域网
                </Switch.Content>
              </Switch>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <output id={`${fieldId}-Base-URL`} className="min-w-0 break-all font-mono text-sm">{baseUrl}</output>
              <div className="flex shrink-0 items-center">
                <Button type="button" aria-label="复制Base URL" isIconOnly size="sm" variant="ghost" onPress={() => void copy('Base URL', baseUrl)}>{copied === 'Base URL' ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}</Button>
              </div>
              <Popover isOpen={editingPort} onOpenChange={open => { if (!busy) { setPort(savedPort); setEditingPort(open); } }}>
                <Button type="button" size="sm" variant="ghost" aria-label={`修改端口，当前 ${savedPort}`} isDisabled={busy}
                  className="h-6 gap-1 rounded-full bg-default/70 px-2 text-xs font-normal text-muted hover:text-foreground">
                  端口 <span className="font-mono tabular-nums">{savedPort}</span><Pencil aria-hidden="true" className="size-3" />
                </Button>
                <Popover.Content placement="bottom start" className="w-72">
                  <Popover.Dialog className="grid gap-3 p-3 outline-none">
                    <Popover.Heading className="text-sm font-medium">网关端口</Popover.Heading>
                    <NumberField value={port} minValue={MIN_PORT} maxValue={MAX_PORT} step={1} isDisabled={busy} autoFocus
                      formatOptions={{ useGrouping: false }} onChange={value => setPort(Number.isFinite(value) ? Math.round(value) : savedPort)}>
                      <Label className="sr-only">端口</Label>
                      <NumberField.Group><NumberField.Input className="font-mono" /></NumberField.Group>
                      <Description className="text-xs">{MIN_PORT}–{MAX_PORT}。保存后网关自动重启，已接入的工具需改用新地址。</Description>
                    </NumberField>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => { setPort(savedPort); setEditingPort(false); }}>取消</Button>
                      <Button size="sm" variant="primary" isDisabled={busy || !portValid || port === savedPort} aria-busy={busy} onPress={() => void savePort()}>保存</Button>
                    </div>
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>
            </div>
            {lan ? (lanUrls.length ? lanUrls.map(url => <div key={url} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 select-all break-all font-mono text-sm">{url}</span>
              <Button type="button" aria-label={`复制 ${url}`} isIconOnly size="sm" variant="ghost" className="shrink-0" onPress={() => void copy(url, url)}>{copied === url ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}</Button>
            </div>) : <span className="text-sm text-muted">未检测到局域网地址</span>) : null}
            <Description className="text-xs">网关地址，填入 {baseVariable}。</Description>
          </div>
          <div className="grid min-w-0 gap-2">
            <Label className="inline-flex items-center gap-1.5" htmlFor={`${fieldId}-API_KEY`}><Key aria-hidden="true" className="size-4 shrink-0" />API_KEY</Label>
            <div className="flex min-w-0 items-center gap-1">
              <output id={`${fieldId}-API_KEY`} className="min-w-0 break-all font-mono text-sm">{!token ? (error ? '读取失败' : '正在读取…') : showToken ? token : `${token.startsWith('sk-') ? 'sk-' : ''}••••••••••••••••${token.slice(-4)}`}</output>
              <div className="flex shrink-0 items-center">
                <Button type="button" aria-label={showToken ? '隐藏 API_KEY' : '显示 API_KEY'} isIconOnly size="sm" variant="ghost" isDisabled={!token || resetting} onPress={() => setShowToken(value => !value)}>{showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
                <Button type="button" aria-label="复制 API_KEY" isIconOnly size="sm" variant="ghost" isDisabled={!token || resetting} onPress={() => void copy('API_KEY', token)}>{copied === 'API_KEY' ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}</Button>
                <Button type="button" aria-label="重置 API_KEY" isIconOnly size="sm" variant="ghost" isDisabled={!token || resetting || !running || Boolean(snapshot?.credentialError)} aria-busy={resetting} onPress={() => void resetAccessToken()}><RotateCcw className={`size-4 ${resetting ? 'animate-spin motion-reduce:animate-none' : ''}`} /></Button>
              </div>
            </div>
            <Description className="text-xs">网关访问密钥，填入 {keyName}。重置后需更新工具中的密钥。</Description>
          </div>
          <div className="grid min-w-0 gap-3">
            <Label>模型列表</Label>
          <Accordion hideSeparator allowsMultipleExpanded defaultExpandedKeys={[]} className="w-full min-w-0">
            {channels.map(accounts => {
              const provider = accounts[0];
              const preset = (snapshot?.presets ?? ROUTER_PRESETS).find(p => p.id === provider.preset);
              const models = [...new Set(accounts.flatMap(account => account.models))];
              const id = channelKey(provider);
              return <Accordion.Item key={id} id={id}>
                <Accordion.Heading>
                  <Accordion.Trigger className="gap-2 px-0 py-2 text-sm hover:bg-transparent">
                    <ProviderIcon provider={preset?.icon ?? provider.preset ?? provider.id} size={18} />
                    <span className="min-w-0 flex-1 break-words">{preset?.name ?? gatewayToolName(provider)}</span>
                    <Accordion.Indicator />
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="px-0 pt-2">
                    {models.length ? <div role="group" aria-label={`${preset?.name ?? gatewayToolName(provider)} 模型`} className="flex flex-wrap gap-1.5">
                      {models.map(model => {
                        const selected = modelDrafts[id]?.[model] ?? accounts.filter(account => account.models.includes(model)).every(account => !account.excludedModels?.includes(model));
                        return <ToggleButton key={model} size="sm" isSelected={selected}
                          onChange={value => selectModel(id, model, value)} className="transform-none! h-7 max-w-full gap-1 px-2 text-xs md:h-7 [&_svg]:size-3">
                          <span title={model}>{accounts.map(account => modelNames[account.id]?.[model]).find(Boolean) ?? model}</span>{selected ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                        </ToggleButton>;
                      })}
                    </div> : <p className="text-sm text-muted">暂无模型</p>}
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>;
            })}
          </Accordion>
          </div>
        </Form><span role="status" className="sr-only">{copied ? `${copied}已复制` : ''}</span>
    </Card.Content>
  </Card>;
}

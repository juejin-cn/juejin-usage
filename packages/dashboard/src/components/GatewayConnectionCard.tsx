import { useGatewayModelNames } from '@/lib/gateway-model-names';
import { channelKey, groupChannels, isVisibleGatewayProvider } from '@/lib/gateway-channels';
import { gatewayToolName } from '@/lib/gateway-onboarding';
import { ROUTER_PRESETS } from '@juejin-opensource/jusage-core/agent-router/presets';
import { ProviderIcon } from './ProviderIcon';
import { Accordion, Button, Description, Form, Label, Card, Tabs, ToggleButton } from '@heroui/react';
import { Key, Link } from '@gravity-ui/icons';
import { Check, Copy, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { saveRouter, routerRequest, type AgentRouterSnapshot } from '@/lib/agent-router';
import type { Protocol } from '@juejin-opensource/jusage-core/agent-router';

const apis = {
  messages: { label: 'Anthropic' },
  responses: { label: 'Responses' },
  chat: { label: 'Chat' },
};

export function GatewayConnectionCard({ snapshot, onRefresh }: {
  snapshot: AgentRouterSnapshot | null; onRefresh: () => Promise<unknown>;
}) {
  const fieldId = useId();
  const [modelDrafts, setModelDrafts] = useState<Record<string, Record<string, boolean>>>({});
  const [savingModels, setSavingModels] = useState(false);
  const savingModelsRef = useRef(false);
  const pendingModels = useRef<Record<string, Record<string, boolean>>>({});
  const tokenRevision = useRef(0);
  const [resetting, setResetting] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('messages');
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
  const baseUrl = anthropic ? base.replace(/\/v1$/, '') : base;
  const prefix = anthropic ? 'ANTHROPIC' : 'OPENAI';
  const keyName = anthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
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
  function field(id: string, value: string, description: string) {
    return <div className="grid min-w-0 gap-1">
      <Label className="inline-flex items-center gap-1.5" htmlFor={`${fieldId}-${id.replaceAll(' ', '-')}`}>{id === 'Base URL' ? <Link aria-hidden="true" className="size-4 shrink-0" /> : null}{id}</Label>
      <div className="flex min-w-0 items-center gap-2">
        <output id={`${fieldId}-${id.replaceAll(' ', '-')}`} className="min-w-0 break-all font-mono text-sm">{value}</output>
        <Button type="button" aria-label={`复制${id}`} isIconOnly size="sm" variant="ghost" className="shrink-0" onPress={() => void copy(id, value)}>{copied === id ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}</Button>
      </div>
      <Description className="text-xs">{description}</Description>
    </div>;
  }

  return <Card className="min-w-0 rounded-2xl" aria-label="网关配置" aria-busy={savingModels}>
    <Card.Header className="flex-row flex-wrap items-center justify-between gap-3">
      <Card.Title>网关配置</Card.Title>
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
          <div className="grid min-w-0 gap-2">
            {field('Base URL', baseUrl, `网关地址，填入 ${prefix}_BASE_URL。`)}
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

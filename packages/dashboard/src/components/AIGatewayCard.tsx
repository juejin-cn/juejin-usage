import { GatewayRequestLogs } from './GatewayRequestLogs';
import { GatewayLoadingSkeleton } from './GatewayLoadingSkeleton';
import { PanelTabs } from './PanelTabs';
import { GatewayProviderDetails } from './GatewayProviderDetails';
import { groupChannels, isVisibleGatewayProvider } from '@/lib/gateway-channels';
import { Badge, Button, ButtonGroup, Card, Chip, Modal } from '@heroui/react';
import { ArrowsRotateLeft, StopFill, LocationArrowFill, ChevronRight } from '@gravity-ui/icons';
import { GatewayAuthorizationModal } from './GatewayAuthorizationModal';
import { ProviderIcon } from './ProviderIcon';
import { connectGatewayTool, gatewayToolName } from '@/lib/gateway-onboarding';
import { GatewayRuntimesCard } from './GatewayRuntimesCard';
import { GatewayConnectionCard } from './GatewayConnectionCard';
import { Box, LoaderCircle, Plus } from 'lucide-react';
import { SubscriptionBrandIcon, type SubscriptionBrand } from './SubscriptionBrandIcon';
import { ROUTER_PRESETS, CHANNEL_CATALOG } from '@juejin-opensource/jusage-core/agent-router/presets';
import { routerErrorMessage } from '@/lib/agent-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RouterProvider } from '@juejin-opensource/jusage-core/agent-router';
import { hasAgentRouter, routerRequest, saveRouter, type AgentRouterSnapshot } from '@/lib/agent-router';

function ToolIcon({ id, compact = false, plain = false }: { id: string; compact?: boolean; plain?: boolean }) {
  const icon = ROUTER_PRESETS.find(p => p.id === id)?.icon ?? (id.startsWith('siliconflow') ? 'siliconcloud' : undefined);
  const brand: SubscriptionBrand | null = id.startsWith('qoder') ? 'qoder' : id.startsWith('workbuddy') ? 'workbuddy' : id.startsWith('deepseek') ? 'deepseek' : id.startsWith('glm') ? 'zcode' : null;
  return <span style={plain ? undefined : { boxShadow: '0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05)' }} className={`flex shrink-0 items-center justify-center rounded-lg bg-surface ${plain ? 'size-4.5 bg-transparent' : compact ? 'size-8' : 'size-10'}`}>{icon ? <ProviderIcon provider={icon} size={18} /> : brand ? <SubscriptionBrandIcon brand={brand} /> : <Box className="size-5 text-muted" />}</span>;
}

function ChannelChip({ children, color = 'default' }: {
  children: ReactNode; color?: 'default' | 'success' | 'warning';
}) {
  const colors = {
    default: 'bg-surface text-foreground/75 ring-1 ring-inset ring-border/50',
    success: 'bg-success-soft text-success-soft-foreground',
    warning: 'bg-warning-soft text-warning-soft-foreground',
  };
  return <Chip variant="soft" color={color} className={`h-5 shrink-0 whitespace-nowrap rounded-full px-1.5 py-0 text-[11px] leading-5 ${colors[color]}`}>
    <Chip.Label className="px-0 font-normal">{children}</Chip.Label>
  </Chip>;
}

const COMMON_GATEWAY_PRESETS = new Set(CHANNEL_CATALOG.map(channel => channel.id as string));

export function AIGatewayCard() {
  const supported = hasAgentRouter();
  const [initialLoading, setInitialLoading] = useState(supported);
  const [showLogs, setShowLogs] = useState(false);
  const [snapshot, setSnapshot] = useState<AgentRouterSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggleTarget, setToggleTarget] = useState<boolean | null>(null);
  const [restarting, setRestarting] = useState(false);
  const lock = useRef(false);
  const revision = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [connectingTool, setConnectingTool] = useState<string | null>(null);
  const [authorizingProvider, setAuthorizingProvider] = useState<RouterProvider | null>(null);
  const [detailProvider, setDetailProvider] = useState<RouterProvider | null>(null);
  const newAuthorizationId = useRef<string | null>(null);
  const returnToDetails = useRef<RouterProvider | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [login, setLogin] = useState<{ providerId: string; url: string } | null>(null);
  const refresh = useCallback(async () => {
    const next = await routerRequest<AgentRouterSnapshot>();
    setSnapshot(next);
    return next;
  }, []);
  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    const revealAfter = performance.now() + 350;
    const poll = async () => {
      if (lock.current) return;
      const requestedRevision = revision.current;
      try {
        const next = await routerRequest<AgentRouterSnapshot>();
        // Avoid flashing a skeleton for fast local responses on panel entry.
        const remaining = revealAfter - performance.now();
        if (remaining > 0) await new Promise<void>(resolve => window.setTimeout(resolve, remaining));
        if (!disposed && requestedRevision === revision.current && !lock.current) {
          setSnapshot(next); setError(null); setInitialLoading(false);
        }
      } catch (e) { if (!disposed && requestedRevision === revision.current && !lock.current) { setInitialLoading(false); setError(String(e instanceof Error ? e.message : e)); } }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [supported]);

  async function run(action: () => Promise<void>, minimumPendingMs = 0) {
    if (lock.current) return;
    revision.current++;
    lock.current = true; setBusy(true); setError(null); setModalError(null);
    try {
      // Start the request immediately; keep successful fast operations pending long
      // enough to see the feedback, before publishing the refreshed snapshot.
      await Promise.all([
        action(),
        new Promise<void>(resolve => window.setTimeout(resolve, minimumPendingMs)),
      ]);
      await refresh();
    }
    catch (e) {
      (adding ? setModalError : setError)(e instanceof Error ? e.message : String(e));
      try { await refresh(); } catch { /* Keep the last confirmed snapshot visible while the service recovers. */ }
    } finally { lock.current = false; setBusy(false); }
  }
  const running = snapshot?.phase === 'running';
  const post = <T,>(path: string, providerId?: string) => routerRequest<T>(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId }),
  });
  async function toggle(value: boolean) {
    if (lock.current) return;
    setToggleTarget(value);
    try {
      await run(async () => {
        if (value && snapshot && snapshot.config.port < 10000) {
          await saveRouter({ ...snapshot.config, port: 18453 });
        }
        await post(value ? '/start' : '/stop');
        if (!value) { setLogin(null); }
      }, value ? 1000 : 0);
    } finally { setToggleTarget(null); }
  }
  async function restartGateway() {
    if (lock.current || !running) return;
    setRestarting(true);
    try {
      await run(async () => {
        await post('/stop');
        setLogin(null);
        await post('/start');
      }, 1000);
    } finally { setRestarting(false); }
  }
  const switching = restarting || toggleTarget !== null || snapshot?.phase === 'draining';
  const ready = Boolean(snapshot && !busy && !snapshot.error);
  const channels = groupChannels(snapshot?.config.providers.filter(isVisibleGatewayProvider) ?? []);
  const tools = channels;
  const gatewayPresets = (snapshot?.presets ?? [])
    .filter(p => p.subscription && COMMON_GATEWAY_PRESETS.has(p.id));
  function openPicker() { setModalError(null); setError(null); setAdding(true); }
  function loginTool(provider: RouterProvider) {
    if (provider.auth.kind === 'subscription' && provider.auth.method === 'browser') { setAdding(false); setAuthorizingProvider(provider); return; }
    void run(async () => {
      if (provider.auth.kind === 'oauth') { const result = await post<{ url: string }>('/oauth/start', provider.id); setLogin({ providerId: provider.id, url: result.url }); return; }
      const authorizing = snapshot?.providers.find(p => p.id === provider.id)?.subscription?.phase === 'authorizing';
      if (authorizing) { await post('/subscription/cancel', provider.id); setLogin(null); }
      else { const result = await post<{ url: string }>('/subscription/login', provider.id); setLogin({ providerId: provider.id, url: result.url }); }
    });
  }

  function connectTool(id: string, newAccount = false) {
    const existing = snapshot?.config.providers.find(p => p.preset === id);
    if (existing && !newAccount) {
      setAdding(false);
      setDetailProvider(existing);
      return;
    }
    if (lock.current) return;
    const definition = gatewayPresets.find(p => p.id === id);
    if (!definition?.subscription) return;
    setConnectingTool(id);
    let createdProvider: RouterProvider;
    void run(async () => {
      try {
        await connectGatewayTool(id, {
          snapshot: () => routerRequest<AgentRouterSnapshot>(),
          save: saveRouter,
          remove: id => post('/providers/remove', id),
          start: () => post('/start'),
          login: async () => { newAuthorizationId.current = createdProvider.id; setAuthorizingProvider(createdProvider); return { url: '' }; },
          onCreated: provider => {
            createdProvider = provider; setAdding(false);
            if (newAccount) { returnToDetails.current = existing ?? provider; setDetailProvider(null); }
          },
          onAuthorization: (providerId, url) => setLogin({ providerId, url }),
          openExternal: async url => {
            const host = (window as unknown as { tud?: { openExternal?: (url: string) => Promise<{ ok: boolean; message?: string }> } }).tud;
            if (!host?.openExternal) throw new Error('无法打开授权页，请点击渠道中的「前往授权」。');
            const result = await host.openExternal(url);
            if (!result.ok) throw new Error(result.message || '无法打开授权页，请点击渠道中的「前往授权」。');
          },
        });
      } finally { setConnectingTool(null); }
    });
  }


  return (
    <>
      <section className="min-w-0" aria-label="网关" aria-busy={initialLoading}>
        <header className="mb-5 flex min-h-8 flex-wrap items-center justify-between gap-2">
          <PanelTabs />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
            <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm text-muted" role="status" aria-live="polite">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${switching ? 'bg-warning' : running ? 'bg-success' : 'bg-muted'}`} />
              {initialLoading ? '正在连接…' : switching ? (restarting ? '正在重启…' : toggleTarget === true ? '正在启动…' : '正在停止…') : running ? '网关运行中' : '未启动'}
            </span>
            {supported ? <Button size="sm" variant="ghost" onPress={() => setShowLogs(true)}>请求日志</Button> : null}
            {supported ? <Button size="sm" variant="outline" isDisabled={!ready} onPress={openPicker}><Plus className="size-4" />添加供应商</Button> : null}
            <ButtonGroup size="sm" aria-label="网关操作">
              {running ? <Button isIconOnly size="sm" variant="danger-soft" aria-label="重启网关" aria-busy={restarting} isDisabled={!ready || switching} onPress={() => void restartGateway()}>
                <ArrowsRotateLeft aria-hidden="true" className={`size-4 ${restarting ? 'animate-spin motion-reduce:animate-none' : ''}`} />
              </Button> : null}
              <Button isIconOnly={running} size="sm" variant={running ? 'danger-soft' : 'primary'} className={running ? undefined : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'} aria-label={toggleTarget !== null ? (toggleTarget ? '正在启动网关' : '正在停止网关') : running ? '停止网关' : '启动网关'} aria-busy={toggleTarget !== null} isDisabled={!supported || !ready || switching} onPress={() => void toggle(!running)}>
                {toggleTarget !== null ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : running ? <StopFill aria-hidden="true" className="size-4" /> : <LocationArrowFill aria-hidden="true" className="size-4" />}
                {!running ? (toggleTarget === true ? '启动中…' : '启动') : null}
              </Button>
            </ButtonGroup>
          </div>
        </header>
        <div className="grid gap-4">
          {!supported ? <p className="text-sm text-muted">路由网关在 Tauri 客户端中提供。</p> : <>
            {snapshot?.archive?.error ? <p role="alert" className="text-sm text-warning">请求日志：{routerErrorMessage(snapshot.archive.error)}</p> : null}
            {snapshot?.credentialError ? <p role="alert" className="text-sm text-warning">{routerErrorMessage(snapshot.credentialError)}</p> : null}
            {!adding && !/CREDENTIAL_UNAVAILABLE|密钥环境变量未设置/.test(error || snapshot?.error || '') && (error || snapshot?.error) ? <p role="alert" className="text-sm text-danger">{error || snapshot?.error}</p> : null}
            {initialLoading ? <GatewayLoadingSkeleton /> : !snapshot ? null : tools.length === 0 ? (
              <div className="panel-fade-in flex flex-col items-center gap-4 py-10">
                <span className="flex size-14 items-center justify-center rounded-2xl bg-surface-secondary"><Box className="size-7 text-muted" /></span>
                <p className="text-sm text-muted">暂无渠道工具</p>
              </div>
            ) : <>
              <div className="panel-fade-in grid grid-cols-3 gap-2.5">
                {tools.map(accounts => {
                  const provider = accounts.find(p => p.enabled && snapshot.providers.find(status => status.id === p.id)?.ready) ?? accounts.find(p => p.enabled) ?? accounts[0];
                  const channelName = ROUTER_PRESETS.find(p => p.id === provider.preset)?.name ?? provider.name;
                  const status = snapshot.providers.find(p => p.id === provider.id);
                  const authorizing = status?.subscription?.phase === 'authorizing';
                  return <Card key={provider.id} className="min-w-0 self-stretch overflow-hidden rounded-2xl px-3 pb-3 pt-2">
                    <Card.Content className="grid content-start gap-0 p-0">
                    <div className="flex h-7 min-w-0 items-center gap-2">
                    <Badge.Anchor className="shrink-0">
                      <ToolIcon id={provider.preset ?? provider.id} plain />
                      {accounts.length > 1 ? <Badge placement="top-right" size="sm" color="accent" aria-label={`${accounts.length} 个连接`}>
                        {accounts.length}
                      </Badge> : null}
                    </Badge.Anchor>
                    <Card.Title className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 tracking-normal">{channelName}</Card.Title>
                    <Button isIconOnly size="sm" variant="ghost" className="size-7 min-h-7 min-w-7 shrink-0 p-0" aria-label={`设置 ${channelName}`} isDisabled={busy} onPress={() => setDetailProvider(provider)}><ChevronRight className="size-4 text-muted" /></Button>
                    </div>
                    <div className="mt-2 grid gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                      {provider.enabled && !status?.ready && provider.auth.kind !== 'env' ? <Button size="sm" variant="ghost" className="h-5 min-w-0 shrink-0 whitespace-nowrap px-1.5 text-[11px] text-accent" isDisabled={busy || !running} onPress={() => loginTool(provider)}>{authorizing ? '继续登录' : '登录'}</Button> : <ChannelChip color={!provider.enabled ? 'default' : status?.ready ? 'success' : authorizing ? 'warning' : 'default'}>{!provider.enabled ? '已停用' : status?.ready ? '已就绪' : authorizing ? '等待授权' : '未连接'}</ChannelChip>}
                      <ChannelChip>{new Set(accounts.flatMap(p => p.models)).size} 个模型</ChannelChip>
                      <ChannelChip>{provider.auth.kind === 'env' ? 'API Key' : provider.auth.kind === 'subscription' ? ({ browser: (status?.subscription?.authType ?? CHANNEL_CATALOG.find(p => p.id === provider.preset)?.methods[0]?.type) === 'api' ? 'API Key' : 'OAuth', desktop: '本机登录', env: 'API Key', 'pat-env': 'PAT' })[provider.auth.method] : 'OAuth'}</ChannelChip>
                    </div>
                    {status?.subscription?.error && !/CREDENTIAL_UNAVAILABLE|密钥环境变量未设置/.test(status.subscription.error) ? <p className="break-words text-xs text-danger">{routerErrorMessage(status.subscription.error)}</p> : null}

                    {login?.providerId === provider.id && (authorizing || provider.auth.kind === 'oauth') && login.url ? <a className="text-sm text-accent underline" href={login.url} target="_blank" rel="noreferrer">前往授权</a> : null}
                    </div>
                    </Card.Content>
                  </Card>;
                })}
              </div>
            </>}
            {snapshot && running ? <div className="panel-fade-in"><GatewayConnectionCard snapshot={snapshot} onRefresh={refresh} /></div> : null}
            {initialLoading || snapshot ? <GatewayRuntimesCard /> : null}
          </>}
        </div>
      </section>
      {showLogs ? <GatewayRequestLogs onClose={() => setShowLogs(false)} /> : null}
      {authorizingProvider ? <GatewayAuthorizationModal key={authorizingProvider.id} provider={authorizingProvider} isNew={newAuthorizationId.current === authorizingProvider.id} snapshot={snapshot} onClose={providerId => {
        newAuthorizationId.current = null;
        setAuthorizingProvider(null);
        if (returnToDetails.current) { setDetailProvider(snapshot?.config.providers.find(p => p.id === providerId) ?? returnToDetails.current); returnToDetails.current = null; }
      }} onRefresh={refresh} /> : null}
      {detailProvider ? <Modal.Backdrop isOpen onOpenChange={open => { if (!open && !savingDetails) setDetailProvider(null); }} variant="opaque">
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog aria-label="供应商详情" className="w-full max-w-[36rem] p-5 sm:p-6">
            <Modal.CloseTrigger aria-label="关闭供应商详情" isDisabled={savingDetails} />
            <Modal.Header className="pr-8">
              <Modal.Heading className="flex items-center gap-2">
                <ToolIcon id={detailProvider.preset ?? detailProvider.id} plain />
                {ROUTER_PRESETS.find(p => p.id === detailProvider.preset)?.name ?? gatewayToolName(detailProvider)}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="min-h-48">
              <GatewayProviderDetails key={detailProvider.id} provider={detailProvider} snapshot={snapshot} onRefresh={refresh} onSavingChange={setSavingDetails}
                isAddingAccount={busy || savingDetails}
                onAddAccount={detailProvider.preset && gatewayPresets.some(p => p.id === detailProvider.preset) ? () => connectTool(detailProvider.preset!, true) : undefined} />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop> : null}
      <Modal.Backdrop isOpen={adding} onOpenChange={open => { if (!busy) setAdding(open); }} variant="opaque" isDismissable={!busy} isKeyboardDismissDisabled={busy}>
        <Modal.Container size="sm" scroll="inside">
          <Modal.Dialog aria-label="添加供应商" className="w-full max-w-[33.6rem] p-4">
            <Modal.CloseTrigger aria-label="关闭添加供应商" isDisabled={busy} />
            <Modal.Header><Modal.Heading>添加供应商</Modal.Heading></Modal.Header>
            <Modal.Body className="grid gap-4">
              {modalError || error ? <p role="alert" className="text-sm text-danger">{modalError || error}</p> : null}
              {!snapshot?.presets ? <p role="status" className="text-sm text-muted">请重启应用以加载新的工具登录功能。</p> : null}
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="订阅工具">
                {gatewayPresets.map(tool => <Button
                  key={tool.id} type="button" size="sm" variant="ghost"
                  className="h-auto min-h-8 w-full justify-start gap-2 rounded-lg bg-black/3 px-2.5 py-1.5 text-left text-foreground/80 hover:bg-default dark:bg-white/5"
                  isDisabled={!ready || Boolean(snapshot?.credentialError)} aria-busy={connectingTool === tool.id}
                  onPress={() => connectTool(tool.id)}
                >
                  {connectingTool === tool.id ? <LoaderCircle className="size-4.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <ProviderIcon provider={tool.icon ?? tool.id} size={18} />}
                  <span className="min-w-0 whitespace-normal leading-snug">{tool.name}</span>
                </Button>)}
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

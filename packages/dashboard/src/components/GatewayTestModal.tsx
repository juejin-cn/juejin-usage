import { Button, Label, Modal, Tabs, ToggleButton } from '@heroui/react';
import { Check, CircleAlert, CircleCheck, Copy, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ROUTER_PRESETS } from '@juejin-opensource/jusage-core/agent-router/presets';
import { isVisibleGatewayProvider } from '@/lib/gateway-channels';
import { gatewayToolName } from '@/lib/gateway-onboarding';
import { routerErrorMessage, routerRequest, type AgentRouterSnapshot } from '@/lib/agent-router';
import type { Protocol } from '@juejin-opensource/jusage-core/agent-router';
import { GatewayModelRow } from './GatewayModelRow';
import { GatewayModelExpand, GatewayModelSearch, useGatewayModelBrowser } from './GatewayModelBrowser';

type TestResult = { ok: boolean; status: number; latencyMs: number; reply?: string; error?: string };
type Platform = 'windows' | 'unix';
const CONCURRENCY = 4;
const PROTOCOLS: { id: Protocol; label: string }[] = [
  { id: 'chat', label: 'OpenAI' },
  { id: 'responses', label: 'Responses' },
  { id: 'messages', label: 'Anthropic' },
  { id: 'gemini', label: 'Gemini' },
];

function curlRequest(protocol: Protocol, model: string, token: string) {
  const m = JSON.stringify(model);
  switch (protocol) {
    case 'responses': return { path: '/v1/responses', headers: [`Authorization: Bearer ${token}`], body: `{"model": ${m}, "input": "hi"}` };
    case 'messages': return { path: '/v1/messages', headers: [`x-api-key: ${token}`, 'anthropic-version: 2023-06-01'], body: `{"model": ${m}, "max_tokens": 256, "messages": [{"role": "user", "content": "hi"}]}` };
    case 'gemini': return { path: `/v1beta/models/${model}:generateContent`, headers: [`x-goog-api-key: ${token}`], body: '{"contents": [{"parts": [{"text": "hi"}]}]}' };
    default: return { path: '/v1/chat/completions', headers: [`Authorization: Bearer ${token}`], body: `{"model": ${m}, "messages": [{"role": "user", "content": "hi"}]}` };
  }
}

function curlScript(platform: Platform, protocol: Protocol, base: string, token: string, model: string): string {
  const { path, headers, body } = curlRequest(protocol, model, token);
  const lines = [...headers, 'Content-Type: application/json'].map(header => `-H "${header}"`);
  if (platform === 'windows') {
    return [`@'`, body, `'@ | curl.exe ${base}${path} \``, ...lines.map(line => `  ${line} \``), `  --data-binary "@-"`].join('\n');
  }
  return [`curl ${base}${path} \\`, ...lines.map(line => `  ${line} \\`), `  -d '${body.replaceAll("'", `'\\''`)}'`].join('\n');
}

export function GatewayTestModal({ snapshot, onClose }: { snapshot: AgentRouterSnapshot; onClose: () => void }) {
  const ready = new Set(snapshot.providers.filter(item => item.ready).map(item => item.id));
  const providers = snapshot.config.providers.filter(p => p.enabled && ready.has(p.id) && isVisibleGatewayProvider(p));
  const [providerId, setProviderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, TestResult | 'running'>>({});
  const [running, setRunning] = useState(false);
  const [token, setToken] = useState('');
  const [platform, setPlatform] = useState<Platform>(() => navigator.userAgent.includes('Windows') ? 'windows' : 'unix');
  const [base, setBase] = useState(`http://127.0.0.1:${snapshot.port}`);
  const [protocol, setProtocol] = useState<Protocol>('chat');
  const [copied, setCopied] = useState(false);
  const models = providers.filter(p => !providerId || p.id === providerId)
    .flatMap(p => p.models.filter(model => !p.excludedModels?.includes(model)).map(model => `${p.alias ?? p.id}/${model}`));
  const browser = useGatewayModelBrowser(models, undefined, 12);
  const bases = [`http://127.0.0.1:${snapshot.port}`, ...(snapshot.lanUrls ?? []).map(url => url.replace(/\/v1$/, ''))];
  const scriptModel = [...selected][0] ?? models[0] ?? 'provider/model';

  useEffect(() => {
    routerRequest<{ token: string }>('/token').then(result => setToken(result.token)).catch(() => setToken(''));
  }, []);

  function toggle(list: string[], value: boolean) {
    setSelected(previous => { const next = new Set(previous); list.forEach(id => value ? next.add(id) : next.delete(id)); return next; });
  }
  async function runTests() {
    const queue = [...selected];
    if (!queue.length || running) return;
    setRunning(true);
    setResults(previous => ({ ...previous, ...Object.fromEntries(queue.map(id => [id, 'running' as const])) }));
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const model = id;
        try {
          const result = await routerRequest<TestResult>('/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, protocol }) });
          setResults(previous => ({ ...previous, [model]: result }));
        } catch (error) {
          setResults(previous => ({ ...previous, [model]: { ok: false, status: 0, latencyMs: 0, error: error instanceof Error ? error.message : String(error) } }));
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setRunning(false);
  }
  async function copyScript() {
    try { await navigator.clipboard.writeText(curlScript(platform, protocol, base, token || 'YOUR_API_KEY', scriptModel)); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { /* Clipboard denied; the script stays selectable. */ }
  }
  const masked = token ? `${token.slice(0, 3)}••••••••${token.slice(-4)}` : 'YOUR_API_KEY';
  const tested = [...selected].filter(id => results[id]);

  return <Modal.Backdrop isOpen onOpenChange={open => { if (!open && !running) onClose(); }} variant="opaque" isDismissable={!running}>
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog aria-label="测试模型" className="w-full max-w-[40rem] p-5 sm:p-6">
        <Modal.CloseTrigger aria-label="关闭测试模型" isDisabled={running} />
        <Modal.Header><Modal.Heading>测试模型</Modal.Heading></Modal.Header>
        <Modal.Body className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
          <section className="grid min-w-0 gap-2">
            <Label>协议</Label>
            <Tabs className="w-fit" selectedKey={protocol} onSelectionChange={key => { if (!running) { setProtocol(key as Protocol); setResults({}); } }}>
              <Tabs.ListContainer>
                <Tabs.List aria-label="协议" className="w-fit *:h-6 *:w-fit *:px-3 *:text-xs *:font-normal">
                  {PROTOCOLS.map(item => <Tabs.Tab key={item.id} id={item.id}>{item.label}<Tabs.Indicator /></Tabs.Tab>)}
                </Tabs.List>
              </Tabs.ListContainer>
            </Tabs>
          </section>
          <section className="grid min-w-0 gap-2">
            <Label>供应商</Label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="供应商">
              {[null, ...providers.map(p => p.id)].map(id => {
                const provider = providers.find(p => p.id === id);
                return <ToggleButton key={id ?? 'all'} size="sm" className="rounded-full px-2.5 text-xs" isSelected={providerId === id} isDisabled={running}
                  onChange={() => { setProviderId(id); setSelected(new Set()); }}>
                  {provider ? ROUTER_PRESETS.find(p => p.id === provider.preset)?.name ?? gatewayToolName(provider) : '全部'}
                </ToggleButton>;
              })}
            </div>
          </section>
          <section className="grid min-w-0 gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>模型</Label>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                <span className="text-xs tabular-nums text-muted">{selected.size} / {models.length}</span>
                <Button size="sm" variant="tertiary" className="transform-none! h-7 px-2 text-xs" isDisabled={running || !browser.filtered.length} onPress={() => toggle(browser.filtered, true)}>全选</Button>
                <Button size="sm" variant="tertiary" className="transform-none! h-7 px-2 text-xs" isDisabled={running || !browser.filtered.length} onPress={() => toggle(browser.filtered, false)}>全不选</Button>
                <Button size="sm" variant="primary" className="transform-none! h-7 px-3 text-xs" isDisabled={running || !selected.size} aria-busy={running} onPress={() => void runTests()}>
                  {running ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
                  测试{selected.size ? ` ${selected.size} 个` : ''}
                </Button>
              </div>
            </div>
            <GatewayModelSearch browser={browser} isDisabled={running} />
            {browser.shown.length ? <div role="group" aria-label="模型" className="flex min-w-0 flex-wrap gap-1.5">
              {browser.shown.map(id => <GatewayModelRow key={id} id={id} name={id} now={0} selected={selected.has(id)} disabled={running} onChange={value => toggle([id], value)} />)}
            </div> : <p className="text-sm text-muted">{models.length ? '无匹配模型' : '暂无可测试的模型，请先登录供应商'}</p>}
            <GatewayModelExpand browser={browser} />
            {tested.length ? <ul className="grid min-w-0 gap-1.5" aria-label="测试结果">
              {tested.map(id => {
                const result = results[id];
                return <li key={id} className="flex min-w-0 items-start gap-2 rounded-lg bg-default/50 px-2.5 py-1.5 text-xs">
                  {result === 'running' ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted motion-reduce:animate-none" />
                    : result.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />}
                  <span className="min-w-0 shrink-0 break-all font-mono">{id}</span>
                  {result === 'running' ? null : <>
                    <span className="shrink-0 tabular-nums text-muted">{(result.latencyMs / 1000).toFixed(1)}s</span>
                    <span className={`min-w-0 flex-1 break-words ${result.ok ? 'text-muted' : 'text-danger'}`}>
                      {result.ok ? result.reply || '(空回复)' : `${result.status ? `HTTP ${result.status} · ` : ''}${routerErrorMessage(result.error ?? 'GATEWAY_FAILED')}`}
                    </span>
                  </>}
                </li>;
              })}
            </ul> : null}
          </section>
          <section className="grid min-w-0 gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="mr-auto">curl</Label>
              {bases.length > 1 ? <Tabs selectedKey={base} onSelectionChange={key => setBase(String(key))}>
                <Tabs.ListContainer>
                  <Tabs.List aria-label="地址" className="w-fit *:h-6 *:w-fit *:px-3 *:text-xs *:font-normal">
                    {bases.map((url, index) => <Tabs.Tab key={url} id={url}>{index ? url.replace(/^http:\/\//, '') : '本机'}<Tabs.Indicator /></Tabs.Tab>)}
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs> : null}
              <Tabs selectedKey={platform} onSelectionChange={key => setPlatform(key as Platform)}>
                <Tabs.ListContainer>
                  <Tabs.List aria-label="系统" className="w-fit *:h-6 *:w-fit *:px-3 *:text-xs *:font-normal">
                    <Tabs.Tab id="windows">Windows<Tabs.Indicator /></Tabs.Tab>
                    <Tabs.Tab id="unix">macOS · Linux<Tabs.Indicator /></Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </div>
            <div className="relative w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-surface">
              <pre className="max-h-72 w-full max-w-full overflow-auto overscroll-contain whitespace-pre p-3 pr-10 font-mono text-xs leading-relaxed">{curlScript(platform, protocol, base, masked, scriptModel)}</pre>
              <Button isIconOnly size="sm" variant="ghost" aria-label="复制 curl 脚本" className="absolute right-1.5 top-1.5 size-7 min-w-7" onPress={() => void copyScript()}>
                {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
          </section>
        </Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

import { authorizationAccount, gatewayToolName } from '../lib/gateway-onboarding';
import { Button, Description, Form, Input, Label, ListBox, Modal, Select, Spinner, TextField } from '@heroui/react';
import { useEffect, useId, useRef, useState } from 'react';
import { routerErrorMessage, routerRequest, saveRouter, type AgentRouterSnapshot } from '@/lib/agent-router';
import type { LoginMethod, LoginResult, RouterProvider } from '@juejin-opensource/jusage-core/agent-router';

export function GatewayAuthorizationModal({ provider, isNew = false, snapshot, onClose, onRefresh }: {
  provider: RouterProvider; isNew?: boolean; snapshot: AgentRouterSnapshot | null; onClose: (providerId?: string) => void; onRefresh: () => Promise<unknown>;
}) {
  const formId = useId();
  const codeFormId = `${formId}-code`;
  const promptLabel = (message: string) => ({
    'Select GitHub deployment type': 'GitHub 类型',
    'Enter your GitHub Enterprise URL or domain': 'GitHub Enterprise 地址',
  })[message] ?? message;
  const [methods, setMethods] = useState<LoginMethod[]>([]);
  const [methodIndex, setMethodIndex] = useState(0);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [flow, setFlow] = useState<LoginResult | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const disposed = useRef(false);
  const syncingRef = useRef(false);
  const active = snapshot?.providers.find(p => p.id === provider.id)?.subscription;
  const [account] = useState(() => authorizationAccount(isNew, {
    restore: async () => {
      const latest = await routerRequest<AgentRouterSnapshot>();
      if (!latest.config.providers.some(p => p.id === provider.id)) {
        await saveRouter({ ...latest.config, providers: [...latest.config.providers, provider] });
      }
    },
    remove: async () => {
      await routerRequest('/providers/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: provider.id }),
      });
    },
  }));
  const request = async <T,>(path: string, body: object = {}) => {
    if (path !== 'cancel' && path !== 'deduplicate') await account.ensure();
    return routerRequest<T>('/subscription/' + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, providerId: provider.id }),
    });
  };
  async function failed(cause: unknown, fallback: string) {
    const message = cause instanceof Error ? cause.message : fallback;
    try { await account.rollback(); await onRefresh(); }
    catch (cleanupError) {
      if (!disposed.current) setError(`${message}；清理未完成：${cleanupError instanceof Error ? cleanupError.message : '请重试关闭'}`);
      return;
    }
    if (!disposed.current) { setFlow(null); setError(message); }
  }
  async function syncModels() {
    if (syncingRef.current) return;
    syncingRef.current = true; setSyncing(true); setError('');
    try {
      const result = await request<{ duplicate: boolean; providerId: string }>('deduplicate');
      if (result.duplicate) {
        account.commit();
        await onRefresh();
        if (!disposed.current) onClose(result.providerId);
        return;
      }
      const { models } = await routerRequest<{ models: string[] }>('/models', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: provider.id }),
      });
      if (!models.length) throw new Error('登录成功，但当前协议暂无可用模型。');
      const next = await routerRequest<AgentRouterSnapshot>();
      const configured = next.config.providers.find(p => p.id === provider.id);
      if (!configured) throw new Error('渠道已移除。');
      // Preserve models referenced by existing groups; add the current account catalog.
      const required = next.config.groups.flatMap(g => g.members).filter(m => m.startsWith(provider.id + '/')).map(m => m.slice(provider.id.length + 1));
      const selected = [...new Set([...required, ...models])].slice(0, 128);
      if (JSON.stringify(configured.models) !== JSON.stringify(selected)) {
        await saveRouter({ ...next.config, providers: next.config.providers.map(p => p.id === provider.id ? { ...p, models: selected } : p) });
      }
      account.commit();
      await onRefresh();
      if (!disposed.current) onClose(provider.id);
    } catch (error) {
      await failed(error, '读取模型失败，请重试。');
    } finally { syncingRef.current = false; if (!disposed.current) setSyncing(false); }
  }
  async function begin(index: number, answers: Record<string, string>) {
    setBusy(true); setError('');
    try {
      const result = await request<LoginResult>('login', { methodIndex: index, inputs: answers });
      if (disposed.current) return;
      setInputs({}); setFlow(result);
      if (result.url && !result.opened) {
        const host = (window as unknown as { tud?: { openExternal?: (url: string) => Promise<{ ok: boolean }> } }).tud;
        const opened = await host?.openExternal?.(result.url);
        if (!opened?.ok && !disposed.current) setError('无法自动打开授权页，请点击下方「前往授权」。');
      }
      await onRefresh();
      if (result.completed) await syncModels();
    } catch (error) {
      await failed(error, '登录失败，请重试。');
    } finally { if (!disposed.current) setBusy(false); }
  }
  useEffect(() => {
    disposed.current = false;
    let cancelled = false;
    void request<LoginMethod[]>('methods').then(async options => {
      if (cancelled) return;
      setMethods(options);
      const first = options[0];
      if (!first) throw new Error('该插件没有可用的登录方式。');
      if (provider.preset === 'opencode-zen-free') await begin(first.index, { key: 'public' });
      else if (provider.preset !== 'zcode' && first.type === 'oauth' && !first.prompts.length) await begin(first.index, {});
      else setBusy(false);
    }).catch(async error => { if (!cancelled) { await failed(error, '读取登录方式失败。'); setBusy(false); } });
    return () => { cancelled = true; disposed.current = true; };
  }, [provider.id]);
  useEffect(() => {
    if (flow && active?.phase === 'ready' && !error && !busy) void syncModels();
    if (active?.phase === 'error' && !error && !busy && !syncing) {
      setBusy(true);
      void failed(new Error(routerErrorMessage(active.error ?? '登录失败')), '登录失败').finally(() => setBusy(false));
    }
  }, [active?.phase, flow, error, busy]);
  const selected = methods.find(m => m.index === methodIndex);
  async function changeMethod(index: number) {
    setBusy(true); setError('');
    try {
      if (flow && !flow.completed) await request('cancel');
      const options = await request<LoginMethod[]>('methods');
      setMethods(options); setMethodIndex(index); setInputs({}); setCode(''); setFlow(null);
    } catch (error) { await failed(error, '切换登录方式失败。'); }
    finally { setBusy(false); }
  }
  async function updateInput(key: string, value: string) {
    const answers = { ...inputs, [key]: value }; setInputs(answers);
    if (selected?.prompts.find(p => p.key === key)?.type === 'select') {
      try { setMethods(await request<LoginMethod[]>('methods', { inputs: answers })); }
      catch { setError('读取登录选项失败，请重试。'); }
    }
  }
  async function complete() {
    setBusy(true); setError('');
    try { await request('complete', { code }); setCode(''); await onRefresh(); await syncModels(); }
    catch (error) { await failed(error, '验证码验证失败，请重新登录。'); }
    finally { setBusy(false); }
  }
  async function close() {
    setBusy(true);
    try {
      if (isNew) await account.rollback();
      else if (flow && !flow.completed && active?.phase !== 'ready') await request('cancel');
      await onRefresh();
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : '清理账户失败，请重试关闭。'); }
    finally { if (!disposed.current) setBusy(false); }
  }
  return <Modal.Backdrop isOpen onOpenChange={open => { if (!open && !busy && !syncing) close(); }} variant="opaque" isDismissable={!busy && !syncing}>
    <Modal.Container size="sm" scroll="inside"><Modal.Dialog className="p-5" aria-label={`连接 ${gatewayToolName(provider)}`}>
      <Modal.CloseTrigger isDisabled={busy || syncing} />
      <Modal.Header className="pr-8"><Modal.Heading>连接 {gatewayToolName(provider)}</Modal.Heading></Modal.Header>
      <Modal.Body className="grid flex-none gap-4">
        {error || active?.error ? <p role="alert" className="text-sm text-danger">{error || routerErrorMessage(active?.error ?? '')}</p> : null}
        {methods.length > 1 ? <Select variant="secondary"
          value={String(methodIndex)} isDisabled={busy || syncing}
          onChange={value => { if (value !== null) void changeMethod(Number(value)); }}
        >
          <Label>登录方式</Label>
          <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
          <Select.Popover><ListBox>
            {methods.map(method => <ListBox.Item key={method.index} id={String(method.index)} textValue={method.label}>
              {method.label}<ListBox.ItemIndicator />
            </ListBox.Item>)}
          </ListBox></Select.Popover>
        </Select> : null}
        {busy || syncing ? <div className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm" />{syncing ? '正在读取可用模型…' : '正在连接…'}</div> : null}
        {!flow && selected ? <Form id={formId} className="grid gap-3" onSubmit={event => { event.preventDefault(); void begin(methodIndex, inputs); }}>
          {selected.prompts.map(prompt => prompt.type === 'select' ? <Select variant="secondary"
            key={prompt.key} name={prompt.key} value={inputs[prompt.key] || null}
            isDisabled={busy} isRequired placeholder="请选择"
            onChange={value => { if (value !== null) void updateInput(prompt.key, String(value)); }}
          >
            <Label>{promptLabel(prompt.message)}</Label>
            <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
            <Select.Popover><ListBox>
              {prompt.options?.map(option => <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                {option.label}<ListBox.ItemIndicator />
              </ListBox.Item>)}
            </ListBox></Select.Popover>
          </Select> : <TextField key={prompt.key} value={inputs[prompt.key] ?? ''} isDisabled={busy} onChange={value => void updateInput(prompt.key, value)}><Label>{promptLabel(prompt.message)}</Label><Input autoComplete="off" type={prompt.type === 'password' || /token|secret|session|key|pat/i.test(prompt.key) ? 'password' : 'text'} placeholder={prompt.placeholder} /></TextField>)}
          {selected.type === 'api' && !selected.prompts.some(p => ['key', 'token', 'apiKey'].includes(p.key)) ? <TextField value={inputs.key ?? ''} isDisabled={busy} isRequired onChange={value => setInputs(prev => ({ ...prev, key: value }))}><Label>API Key</Label><Input type="password" autoComplete="off" placeholder={provider.preset === 'opencode-zen-free' ? 'public' : undefined} /></TextField> : null}
        </Form> : null}
        {flow ? <div className="grid gap-3">
          {flow.instructions ? <p className="whitespace-pre-wrap break-words text-sm">{flow.instructions}</p> : null}
          {flow.url ? <a className="w-fit text-sm text-accent underline" href={flow.url} target="_blank" rel="noreferrer">前往授权</a> : null}
          {flow.method === 'code' ? <Form id={codeFormId} className="grid gap-3" onSubmit={event => { event.preventDefault(); void complete(); }}><TextField isRequired value={code} onChange={setCode} isDisabled={busy}><Label>验证码或回调内容</Label><Input autoComplete="one-time-code" /></TextField></Form> : active?.phase !== 'ready' && !flow.completed ? <Description>完成授权后自动添加可用模型。</Description> : null}
        </div> : null}
      </Modal.Body>
      <Modal.Footer className="gap-2 p-0">
        <Button size="sm" variant="tertiary" isDisabled={busy || syncing} onPress={close}>{flow ? '关闭' : '取消'}</Button>
        {!flow && selected ? <Button size="sm" type="submit" form={formId} isDisabled={busy || syncing}>连接</Button> : null}
        {flow && active?.phase === 'error' ? <Button size="sm" isDisabled={busy || syncing} onPress={() => void changeMethod(methodIndex)}>重新登录</Button> : null}
        {flow?.method === 'code' ? <Button type="submit" form={codeFormId} size="sm" isDisabled={busy || syncing || !code.trim()}>完成登录</Button> : null}
        {flow && error && (active?.phase === 'ready' || flow.completed) ? <Button size="sm" isDisabled={busy || syncing} onPress={() => void syncModels()}>重试读取模型</Button> : null}
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
}

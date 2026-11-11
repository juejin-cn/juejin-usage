import { Button, Input, Label, Modal, TextField, ToggleButton } from '@heroui/react';
import { Check, Copy, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Protocol, RouterProvider } from '@juejin-opensource/jusage-core/agent-router';
import {
  CUSTOM_PROVIDER_PROTOCOLS,
  customCredentialChanged,
  draftCustomGatewayProvider,
  type CustomGatewayProviderInput,
} from '@/lib/gateway-onboarding';
import { routerErrorMessage, routerRequest } from '@/lib/agent-router';
import { GatewayModelRow } from './GatewayModelRow';
import { GatewayModelExpand, GatewayModelSearch, useGatewayModelBrowser } from './GatewayModelBrowser';

function parseModels(value: string): string[] {
  return value.split(/[,，\n]+/).map(item => item.trim()).filter(Boolean);
}

export function GatewayCustomProviderModal({
  provider,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  provider?: RouterProvider;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: CustomGatewayProviderInput) => Promise<void>;
}) {
  const editing = Boolean(provider);
  const [name, setName] = useState(provider?.name ?? '');
  const [protocol, setProtocol] = useState<Protocol>(provider?.protocol ?? 'chat');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState(editing);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [models, setModels] = useState<string[]>(provider?.models ?? []);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(provider?.excludedModels ?? []));
  const [modelInput, setModelInput] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const saving = busy || fetching || loadingKey;
  const browser = useGatewayModelBrowser(models);
  const bindingChanged = !provider || customCredentialChanged(provider, { protocol, baseUrl });
  const canFetch = Boolean(baseUrl.trim()) && (Boolean(apiKey.trim()) || !bindingChanged);

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    routerRequest<{ key: string | null }>('/credentials/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: provider.id }),
    }).then(result => {
      if (cancelled || !result.key) return;
      setSavedKey(result.key);
      setApiKey(result.key);
    }).catch(error => {
      if (!cancelled) setLocalError(routerErrorMessage(error instanceof Error ? error.message : String(error)));
    }).finally(() => { if (!cancelled) setLoadingKey(false); });
    return () => { cancelled = true; };
  }, [provider]);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(apiKey.trim());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setLocalError('复制失败，请手动选择密钥。');
    }
  }

  function addModels() {
    const added = parseModels(modelInput);
    if (!added.length) return;
    setModels(previous => [...new Set([...previous, ...added])]);
    setExcluded(previous => { const next = new Set(previous); added.forEach(model => next.delete(model)); return next; });
    setModelInput('');
  }

  function setSelected(list: string[], selected: boolean) {
    setExcluded(previous => {
      const next = new Set(previous);
      list.forEach(model => { if (selected) next.delete(model); else next.add(model); });
      return next;
    });
  }

  async function fetchModels() {
    setLocalError(null);
    setFetching(true);
    try {
      const draft = draftCustomGatewayProvider({ name, protocol, baseUrl, apiKey, models: [] }, provider);
      const catalog = await routerRequest<{ models: string[] }>('/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: draft, key: apiKey.trim() }),
      });
      if (!catalog.models.length) throw new Error('当前地址未返回可用模型，请手动填写模型 ID。');
      setModels(catalog.models.slice(0, 128));
      setExcluded(new Set());
    } catch (error) {
      setLocalError(routerErrorMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setFetching(false);
    }
  }

  async function submit() {
    setLocalError(null);
    const pending = parseModels(modelInput);
    const all = [...new Set([...models, ...pending])];
    const unchangedKey = !bindingChanged && savedKey !== null && apiKey.trim() === savedKey;
    try {
      await onSubmit({
        name,
        protocol,
        baseUrl,
        apiKey: unchangedKey ? '' : apiKey,
        models: all,
        excludedModels: all.filter(model => excluded.has(model) && !pending.includes(model)),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  const heading = editing ? '编辑供应商' : '自定义供应商';

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={open => { if (!open && !saving) onClose(); }}
      variant="opaque"
      isDismissable={!saving}
      isKeyboardDismissDisabled={saving}
    >
      <Modal.Container size="sm" scroll="inside">
        <Modal.Dialog aria-label={heading} className="w-full max-w-[33.6rem] p-4">
          <Modal.CloseTrigger aria-label={`关闭${heading}`} isDisabled={saving} />
          <Modal.Header><Modal.Heading>{heading}</Modal.Heading></Modal.Header>
          <Modal.Body className="grid gap-4">
            {localError || error ? <p role="alert" className="text-sm text-danger">{localError || error}</p> : null}
            <TextField value={name} isDisabled={saving} isRequired onChange={setName}>
              <Label>名称</Label>
              <Input placeholder="例如 My Relay" autoComplete="off" />
            </TextField>
            <div className="grid gap-2">
              <Label>Base URL</Label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="协议">
                {CUSTOM_PROVIDER_PROTOCOLS.map(item => (
                  <ToggleButton
                    key={item.id}
                    size="sm"
                    className="rounded-full px-2.5 text-xs"
                    isSelected={protocol === item.id}
                    isDisabled={saving}
                    onChange={() => setProtocol(item.id)}
                  >
                    {item.label}
                  </ToggleButton>
                ))}
              </div>
              <TextField value={baseUrl} isDisabled={saving} isRequired onChange={setBaseUrl}>
                <Label className="sr-only">Base URL</Label>
                <Input placeholder="https://.../v1" autoComplete="off" />
              </TextField>
            </div>
            <div className="grid gap-2">
              <Label>API 密钥</Label>
              <div className="flex items-center gap-1">
                <TextField className="min-w-0 flex-1" value={apiKey} isDisabled={saving} isRequired={bindingChanged} onChange={setApiKey}>
                  <Label className="sr-only">API 密钥</Label>
                  <Input type={showKey ? 'text' : 'password'} placeholder={loadingKey ? '正在读取…' : '粘贴 API 密钥'} autoComplete="off" />
                </TextField>
                <Button isIconOnly size="sm" variant="ghost" aria-label={showKey ? '隐藏 API 密钥' : '显示 API 密钥'} isDisabled={!apiKey} onPress={() => setShowKey(value => !value)}>
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
                <Button isIconOnly size="sm" variant="ghost" aria-label="复制 API 密钥" isDisabled={!apiKey.trim()} onPress={() => void copyKey()}>
                  {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                </Button>
              </div>
              <p className="text-xs leading-relaxed text-muted">密钥加密保存在本机 ~/.ai-usage 网关凭据库，不写进配置文件，也不读取 shell 环境变量。</p>
            </div>
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>模型</Label>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  {models.length ? <>
                    <span className="text-xs tabular-nums text-muted">{models.filter(model => !excluded.has(model)).length} / {models.length}</span>
                    <Button size="sm" variant="tertiary" className="transform-none! h-7 px-2 text-xs" isDisabled={saving || !browser.filtered.length} onPress={() => setSelected(browser.filtered, true)}>全选</Button>
                    <Button size="sm" variant="tertiary" className="transform-none! h-7 px-2 text-xs" isDisabled={saving || !browser.filtered.length} onPress={() => setSelected(browser.filtered, false)}>全不选</Button>
                  </> : null}
                  <Button
                    size="sm"
                    variant="tertiary"
                    className="transform-none! h-7 px-2 text-xs"
                    isDisabled={saving || !canFetch}
                    aria-busy={fetching}
                    onPress={() => void fetchModels()}
                  >
                    {fetching ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
                    获取模型
                  </Button>
                </div>
              </div>
              <GatewayModelSearch browser={browser} isDisabled={saving} />
              {browser.shown.length ? <div role="group" aria-label="模型" className="flex max-h-48 min-w-0 flex-wrap gap-1.5 overflow-y-auto">
                {browser.shown.map(model => <GatewayModelRow key={model} id={model} name={model} now={0}
                  selected={!excluded.has(model)} disabled={saving} onChange={value => setSelected([model], value)} />)}
              </div> : models.length ? <p className="text-sm text-muted">无匹配模型</p> : null}
              <GatewayModelExpand browser={browser} />
              <div className="flex gap-2">
                <TextField className="min-w-0 flex-1" value={modelInput} isDisabled={saving} onChange={setModelInput}>
                  <Label className="sr-only">添加模型</Label>
                  <Input
                    placeholder="模型 ID，逗号分隔 · 例如 gpt-4.1, claude-sonnet-4"
                    autoComplete="off"
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModels(); } }}
                  />
                </TextField>
                <Button size="sm" variant="tertiary" isDisabled={saving || !modelInput.trim()} onPress={addModels}>添加</Button>
              </div>
              {!models.length ? <p className="text-xs leading-relaxed text-muted">不填则保存后自动获取。</p> : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" isDisabled={saving} onPress={onClose}>取消</Button>
              <Button size="sm" variant="primary" isDisabled={saving} aria-busy={busy} onPress={() => void submit()}>
                {busy ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : null}
                {editing ? '保存' : '添加'}
              </Button>
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

import { useState } from 'react';
import { Button, Checkbox, ComboBox, Input, Label, ListBox, Modal, ToggleButton } from '@heroui/react';
import { ArrowLeft, Check, Copy, LoaderCircle, RefreshCw } from 'lucide-react';
import type { IntegrationChoice, IntegrationStatus, IntegrationTool } from '@juejin-opensource/jusage-core/agent-router';
import { routerErrorMessage, routerRequest } from '@/lib/agent-router';
import { CLAUDE_RUNTIMES, RUNTIME_TOOLS, runtimeChoice, runtimeSelectionError, type RuntimeView } from '@/lib/gateway-runtimes';
import { ProviderIcon } from './ProviderIcon';

type Props = {
  view: RuntimeView;
  selected: IntegrationTool | null;
  busy: boolean;
  detecting: boolean;
  error: string;
  onSelect: (id: IntegrationTool | null) => void;
  onClose: () => void;
  onRefresh: () => void;
  onSave: (id: IntegrationTool, choice: IntegrationChoice) => Promise<void>;
  onRemove: (id: IntegrationTool) => Promise<void>;
};

export function GatewayRuntimeModal(props: Props) {
  const tool = props.view.tools.find(tool => tool.id === props.selected);
  return <Modal.Backdrop isOpen onOpenChange={open => { if (!open && !props.busy) props.onClose(); }} variant="opaque" isDismissable={!props.busy} isKeyboardDismissDisabled={props.busy}>
    <Modal.Container size="sm" scroll="inside">
      <Modal.Dialog aria-label={tool ? tool.name : '添加本地工具'} className="w-full max-w-[33.6rem] p-4">
        <Modal.CloseTrigger aria-label="关闭工具接入" isDisabled={props.busy} />
        <Modal.Header className="pr-8">
          <Modal.Heading className="flex items-center gap-2">
            {tool ? <><Button isIconOnly size="sm" variant="ghost" aria-label="返回工具列表" isDisabled={props.busy} onPress={() => props.onSelect(null)}><ArrowLeft className="size-4" /></Button><ProviderIcon provider={tool.icon} size={22} />{tool.name}</> : '添加本地工具'}
          </Modal.Heading>
        </Modal.Header>
        {tool ? <RuntimeSettings key={tool.id} {...props} tool={tool} /> : <>
          <Modal.Body className="grid gap-4">
            {props.error ? <p role="alert" className="mb-3 text-sm text-danger">{props.error}</p> : null}
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="选择工具" aria-busy={props.detecting}>
              {RUNTIME_TOOLS.map(id => {
                const family = id === 'claude' ? props.view.tools.filter(tool => CLAUDE_RUNTIMES.some(entry => entry.id === tool.id)) : props.view.tools.filter(tool => tool.id === id);
                const entry = family.find(tool => tool.installed && !tool.enabled) ?? family.find(tool => tool.installed) ?? family.find(tool => tool.enabled) ?? family[0];
                if (!entry) return null;
                const added = family.some(tool => tool.enabled);
                const availability = !entry.installed ? (added ? '已添加 · 未安装' : '未安装') : added ? '已添加' : '已安装';
                const icon = id === 'claude' ? 'claude-code' : entry.icon;
                return <Button key={id} type="button" size="sm" variant="ghost"
                  className="h-auto min-h-8 w-full justify-start gap-2 rounded-lg bg-black/3 px-2.5 py-1.5 text-left text-foreground/80 hover:bg-default dark:bg-white/5"
                  isDisabled={!entry.installed && !added} onPress={() => props.onSelect(entry.id)}
                >
                  <ProviderIcon provider={icon} size={18} />
                  <span className="min-w-0 flex-1 whitespace-normal leading-snug">{id === 'claude' ? 'Claude Code' : entry.name}</span>
                  <span className="shrink-0 text-[11px] text-muted">{availability}</span>
                </Button>;
              })}
            </div>
          </Modal.Body>
          <Modal.Footer><Button size="sm" variant="ghost" isDisabled={props.detecting} aria-busy={props.detecting} onPress={props.onRefresh}><RefreshCw className={`size-3.5 ${props.detecting ? 'animate-spin motion-reduce:animate-none' : ''}`} />{props.detecting ? '正在探测…' : '刷新工具状态'}</Button></Modal.Footer>
        </>}
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}

function RuntimeSettings({ tool, ...props }: Props & { tool: IntegrationStatus }) {
  const [choice, setChoice] = useState<IntegrationChoice>(() => runtimeChoice(tool, props.view.models));
  const selectedIds = choice.mode === 'all' ? props.view.models.map(model => model.id) : choice.models;
  const selectedModels = props.view.models.filter(model => selectedIds.includes(model.id));
  const disabledReason = runtimeSelectionError(props.view, tool, choice);
  const desktop = tool.id === 'claude-desktop';
  const guided = desktop;
  const claude = CLAUDE_RUNTIMES.some(entry => entry.id === tool.id);
  const busy = props.busy;
  const reconnect = tool.error === 'INTEGRATION_CONFLICT';
  function selectModels(ids: string[], mode: IntegrationChoice['mode']) {
    setChoice(previous => ({ mode, models: ids, defaultModel: ids.includes(previous.defaultModel) ? previous.defaultModel : ids[0] ?? '' }));
  }

  return <>
    <Modal.Body className="grid gap-4">
      {claude ? <div className="flex flex-wrap gap-1.5" aria-label="Claude 接入入口">
        {CLAUDE_RUNTIMES.map(entry => <ToggleButton key={entry.id} size="sm" isSelected={tool.id === entry.id} isDisabled={busy} onChange={() => props.onSelect(entry.id)}>{entry.label}</ToggleButton>)}
      </div> : null}
      {reconnect ? <p role="status" className="text-sm text-muted">本机配置已变更，自动同步已暂停。重新接入将应用下方选择；移除接入会保留你的修改。</p> : null}
      {props.error || tool.error && !reconnect ? <p role="alert" className="text-sm text-danger">{props.error || routerErrorMessage(tool.error!)}</p> : null}
      {tool.id === 'gemini' ? <div className="grid gap-1 text-xs leading-relaxed text-muted"><p>配置写入用户目录 ~/.gemini。项目 .env、终端环境变量或 --model 参数可能覆盖这些设置。</p>{tool.warnings?.length ? <p role="status" className="text-warning">检测到环境变量覆盖：{tool.warnings.map(code => code.replace('ENV_OVERRIDE_', '')).join('、')}。请在运行 Gemini 的终端核对。</p> : null}</div> : null}
      {disabledReason ? <p role="status" className="text-sm text-warning">{disabledReason}</p> : null}
      <ComboBox aria-label="默认模型" selectedKey={selectedModels.some(model => model.id === choice.defaultModel) ? choice.defaultModel : null} isDisabled={busy || !selectedModels.length}
        menuTrigger="focus" onSelectionChange={value => { if (value !== null) setChoice(previous => ({ ...previous, defaultModel: String(value) })); }}>
        <Label>默认模型</Label>
        <ComboBox.InputGroup>
          <Input placeholder="搜索或选择默认模型" />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <ComboBox.Popover><ListBox renderEmptyState={() => <p className="px-3 py-2 text-sm text-muted">无匹配模型</p>}>
          {selectedModels.map(model => <ListBox.Item key={model.id} id={model.id} textValue={`${model.name} · ${model.provider}`}><span>{model.name}<span className="ml-2 text-xs text-muted">{model.provider}</span></span><ListBox.ItemIndicator /></ListBox.Item>)}
        </ListBox></ComboBox.Popover>
      </ComboBox>
      <div className="grid gap-3 rounded-xl bg-surface-secondary p-3">
        <Checkbox isSelected={choice.mode === 'all'} isDisabled={busy} onChange={all => selectModels(props.view.models.map(model => model.id), all ? 'all' : 'custom')}>
          <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span className="text-sm">跟随网关全部模型</span></Checkbox.Content>
        </Checkbox>
        {choice.mode === 'custom' ? <div className="grid max-h-48 gap-2 overflow-y-auto" aria-label="开放给工具的模型">
          {props.view.models.map(model => <Checkbox key={model.id} isSelected={selectedIds.includes(model.id)} isDisabled={busy} onChange={on => selectModels(on ? [...selectedIds, model.id] : selectedIds.filter(id => id !== model.id), 'custom')}>
            <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control><span className="min-w-0 break-all text-sm">{model.name}<span className="ml-2 text-xs text-muted">{model.provider}</span></span></Checkbox.Content>
          </Checkbox>)}
        </div> : null}
      </div>
      {guided ? <DesktopGuide view={props.view} choice={{ ...choice, models: selectedIds }} /> : <p className="text-xs leading-relaxed text-muted">
        确认后将更新工具的本机配置。{tool.id === 'claude-vscode' ? '请在 VS Code 中重新加载窗口并开启新会话。' : tool.id === 'pi' ? '请在 Pi 中重新选择模型，默认模型在新会话生效。' : '请重新加载配置或开启新会话。'}移除接入时会恢复仍由网关管理的配置。
      </p>}
    </Modal.Body>
    <Modal.Footer className="flex-wrap gap-2">
      {tool.enabled ? <Button size="sm" variant="danger-soft" className="mr-auto" isDisabled={busy} onPress={() => void props.onRemove(tool.id)}>{guided ? '移除记录' : '移除接入'}</Button> : null}
      <Button size="sm" variant="secondary" isDisabled={busy} onPress={props.onClose}>取消</Button>
      <Button size="sm" isDisabled={busy || Boolean(disabledReason)} aria-busy={busy} onPress={() => void props.onSave(tool.id, reconnect ? { ...choice, reapply: true } : choice)}>
        {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : null}{busy ? '保存中…' : reconnect ? '重新接入' : tool.enabled ? '保存' : guided ? '添加引导' : '接入网关'}
      </Button>
    </Modal.Footer>
  </>;
}

function DesktopGuide({ view, choice }: { view: RuntimeView; choice: IntegrationChoice }) {
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const base = view.baseUrl?.replace(/\/v1$/, '') ?? '';
  async function copy(key: 'base' | 'token' | 'models' | 'default') {
    try {
      setError(''); setCopied('');
      const ids = [choice.defaultModel, ...choice.models.filter(id => id !== choice.defaultModel)].filter(Boolean);
      const value = key === 'base' ? base : key === 'token' ? (await routerRequest<{ token: string }>('/token')).token : key === 'default' ? choice.defaultModel : JSON.stringify(ids.map(name => ({ name })), null, 2);
      await navigator.clipboard.writeText(value); setCopied(key);
    } catch { setError('复制失败，请确认网关已启动及剪贴板权限。'); }
  }
  return <div className="grid gap-3 rounded-xl border border-border/60 p-3 text-sm">
    <p className="font-medium">在 Claude Desktop 中完成配置</p>
    <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-muted">
      <li>Help → Troubleshooting → Enable Developer Mode，重启后打开 Developer → Configure Third-Party Inference。</li>
      <li>选择 Gateway、Static API key 和 Bearer，填入下方网关地址与密钥；在 Models 中填入所选模型，按需要选择默认模型。</li>
      <li>保存后开启新的本地 Code 会话并发送消息验证。组织管理的配置可能使这些设置只读。</li>

    </ol>
    <code className="break-all rounded-lg bg-surface-secondary px-2 py-2 text-xs">{base || '请先启动网关'}</code>
    <div className="flex flex-wrap gap-2">
      {([['base', '复制地址'], ['token', '复制密钥'], ['default', '复制默认模型'], ['models', '复制模型配置']] as const).map(([key, label]) => <Button key={key} size="sm" variant="tertiary" isDisabled={!view.running || !base || (key === 'models' || key === 'default') && !choice.models.length} onPress={() => void copy(key)}>{copied === key ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{label}</Button>)}
    </div>
    {copied ? <p role="status" className="text-xs text-success">已复制</p> : null}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    <p className="text-xs leading-relaxed text-muted">此处只保存引导记录，需在工具中保存配置并验证连接。网关地址、密钥或模型变化后需手动更新。</p>
    <a className="w-fit text-xs text-accent underline" href="https://code.claude.com/docs/en/llm-gateway-connect#desktop-app" target="_blank" rel="noreferrer">查看官方配置说明</a>
  </div>;
}

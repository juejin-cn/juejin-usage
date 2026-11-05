import { isFreeModel } from '@/lib/model-presentation';
import { GatewayModelRow } from './GatewayModelRow';
import { gatewayModelName } from '@juejin-opensource/jusage-core/agent-router/presets';
import { useGatewayModelCatalog } from '@/lib/gateway-model-names';
import { AlertDialog, Dropdown, Button, Label, ListBox, ToggleButton } from '@heroui/react';
import { Ellipsis, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ProviderUsage, RouterProvider } from '@juejin-opensource/jusage-core/agent-router';
import { applyAccountExposureDrafts, channelKey } from '@/lib/gateway-channels';
import { routerRequest, saveRouter, type AgentRouterSnapshot } from '@/lib/agent-router';

type ModelDrafts = Record<string, Record<string, boolean>>;

export function GatewayProviderDetails({ provider, snapshot, onRefresh, onSavingChange, onAddAccount, isAddingAccount }: {
  onAddAccount?: () => void;
  isAddingAccount: boolean;
  provider: RouterProvider;
  snapshot: AgentRouterSnapshot | null;
  onRefresh: () => Promise<unknown>;
  onSavingChange: (saving: boolean) => void;
}) {
  const labelId = useId();
  const [selectedAccount, setSelectedAccount] = useState(provider.id);
  const [onlyFree, setOnlyFree] = useState(false);
  const [drafts, setDrafts] = useState<ModelDrafts>({});
  const [error, setError] = useState('');
  const [removingAccount, setRemovingAccount] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const removingRef = useRef(false);
  const [usage, setUsage] = useState<Record<string, ProviderUsage | null>>({});
  const [usageErrors, setUsageErrors] = useState<Record<string, string>>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageRevision, setUsageRevision] = useState(0);
  const pending = useRef<ModelDrafts>({});
  const saving = useRef(false);
  const accounts = snapshot?.config.providers.filter(account => channelKey(account) === channelKey(provider)) ?? [];
  const account = accounts.find(item => item.id === selectedAccount) ?? accounts[0];
  const models = [...new Set(account?.models ?? [])];
  const { catalogs, errors: modelErrors, now: modelNow } = useGatewayModelCatalog(accounts, snapshot);
  const visibleModels = onlyFree ? models.filter(id => isFreeModel(account ? catalogs[account.id]?.metadata?.[id] : undefined, modelNow)) : models;
  const usageAccountIds = accounts.filter(item => item.auth.kind === 'subscription'
    && snapshot?.providers.find(status => status.id === item.id)?.ready).map(item => item.id).join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = usageAccountIds ? usageAccountIds.split(',') : [];
    setUsageLoading(ids.length > 0);
    setUsageErrors({});
    void Promise.all(ids.map(async providerId => {
        try {
          const result = await routerRequest<ProviderUsage>('/subscription/usage', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId }),
          });
          if (cancelled) return;
          if (result.quotaError) {
            setUsageErrors(previous => ({ ...previous, [providerId]: result.quotaAuthRequired ? '额度查询授权不可用，请重新授权；已有数据为上次结果。' : '额度刷新失败，可重试；已有数据为上次结果。' }));
          }
          setUsage(previous => ({ ...previous, [providerId]: result.quotaError && previous[providerId]?.state === 'available' ? previous[providerId] : result }));
        } catch (error) {
          if (cancelled) return;
          setUsageErrors(previous => ({ ...previous, [providerId]: error instanceof Error ? error.message : '额度读取失败，请重试。' }));
          setUsage(previous => ({ ...previous, [providerId]: previous[providerId] ?? null }));
        }
    })).finally(() => { if (!cancelled) setUsageLoading(false); });
    return () => { cancelled = true; };
  }, [usageAccountIds, usageRevision]);

  async function removeAccount() {
    if (!removingAccount || removingRef.current || saving.current) return;
    removingRef.current = true; setRemoving(true); onSavingChange(true); setRemoveError('');
    try {
      await routerRequest('/providers/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: removingAccount.id }),
      });
      setRemovingAccount(null);
      try { await onRefresh(); } catch { setError('账户已移除，列表刷新失败，请重新打开详情。'); }
    } catch (error) { setRemoveError(error instanceof Error ? error.message : '删除账户失败，请重试。'); }
    finally { removingRef.current = false; setRemoving(false); onSavingChange(false); }
  }

  function selectModels(accountId: string, models: string[], selected: boolean) {
    if (removingRef.current || !models.length) return;
    const changes = Object.fromEntries(models.map(model => [model, selected]));
    pending.current = { ...pending.current, [accountId]: { ...pending.current[accountId], ...changes } };
    setDrafts(previous => ({ ...previous, [accountId]: { ...previous[accountId], ...changes } }));
    void syncModels();
  }
  async function syncModels() {
    if (saving.current) return;
    saving.current = true; onSavingChange(true); setError('');
    try {
      while (Object.keys(pending.current).length) {
        const batch = pending.current;
        pending.current = {};
        const latest = await routerRequest<AgentRouterSnapshot>();
        const providers = applyAccountExposureDrafts(latest.config.providers, batch);
        if (JSON.stringify(providers) !== JSON.stringify(latest.config.providers)) {
          await saveRouter({ ...latest.config, providers });
        }
        await onRefresh();
      }
    } catch (error) {
      pending.current = {};
      setError(error instanceof Error ? error.message : '更新模型失败，请重试。');
      try { await onRefresh(); } catch { /* Retain the last confirmed snapshot. */ }
      pending.current = {};
    } finally {
      setDrafts({}); saving.current = false; onSavingChange(false);
    }
  }

  return <div className="grid min-w-0 gap-5">
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <section className="grid min-w-0 gap-3" aria-labelledby={`${labelId}-accounts`}>
      <div className="flex items-center justify-between">
        <Label id={`${labelId}-accounts`}>我的账户</Label>
        <div className="flex items-center gap-1" role="group" aria-label="账户操作">
        <Button className="transform-none! size-6 min-w-6 p-0 md:size-6" size="sm" variant="tertiary" isIconOnly aria-label="刷新额度" isDisabled={usageLoading || !usageAccountIds}
          onPress={() => setUsageRevision(value => value + 1)}>
          <RefreshCw className={`size-4 ${usageLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} />
        </Button>
        {onAddAccount ? <Button className="transform-none! size-6 min-w-6 p-0 md:size-6" size="sm" variant="tertiary" isIconOnly aria-label="新增账户" isDisabled={isAddingAccount} onPress={onAddAccount}>
          <Plus className="size-4" />
        </Button> : null}
        </div>
      </div>
      <ListBox aria-labelledby={`${labelId}-accounts`} orientation="horizontal" selectionMode="single" disallowEmptySelection
        selectedKeys={account ? [account.id] : []}
        onSelectionChange={keys => { if (keys !== 'all') { const id = [...keys][0]; if (id !== undefined) setSelectedAccount(String(id)); } }}
        className="flex min-w-0 gap-2 overflow-x-auto p-0 [&>*+*]:mt-0">
        {accounts.map(item => {
          const status = snapshot?.providers.find(value => value.id === item.id);
          const details = usage[item.id];
          return <ListBox.Item key={item.id} id={item.id} textValue={details?.accountName ?? item.name}
            className="transform-none! w-full shrink-0 items-start gap-2 rounded-xl border border-border px-3 py-3 data-[selected=true]:border-accent data-[selected=true]:bg-accent-soft/30">
            <div className="grid min-w-0 flex-1 gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Label className="min-w-0 flex-1 truncate">{details?.accountName ?? item.name}</Label>
                {details?.plan ? <span className="shrink-0 rounded bg-default px-1.5 py-0.5 text-xs text-muted">{details.plan}</span> : null}
                <Dropdown>
                  <Button className="transform-none! size-6 min-w-6 p-0 md:size-6" size="sm" variant="ghost" isIconOnly aria-label={`管理账户 ${details?.accountName ?? item.name}`} isDisabled={isAddingAccount || removing}>
                    <Ellipsis className="size-4" />
                  </Button>
                  <Dropdown.Popover placement="bottom end" className="w-max min-w-0">
                    <Dropdown.Menu className="w-max min-w-0" aria-label="账户管理" onAction={() => { setRemoveError(''); setRemovingAccount({ id: item.id, name: details?.accountName ?? item.name }); }}>
                      <Dropdown.Item className="transform-none! gap-2 whitespace-nowrap text-danger" id="remove" textValue="删除账户" variant="danger">
                        <Trash2 className="size-4 text-danger" /><Label>删除账户</Label>
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              </div>
              {usageErrors[item.id] && details?.state === 'available' ? <p role="status" className="text-xs text-muted">{usageErrors[item.id]}</p> : null}
              {status?.ready && details?.state === 'available' ? details.windows.map((window, index) => {
                const percent = window.percent ?? (window.limit && window.used !== undefined ? window.used / window.limit * 100 : undefined);
                const remaining = window.remaining ?? (window.limit !== undefined && window.used !== undefined ? Math.max(0, window.limit - window.used) : undefined);
                const unit = ({ credits: '积分', tokens: 'Token', requests: '次请求', units: '额度' } as Record<string, string>)[window.unit] ?? window.unit;
                const format = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
                return <div key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span>{remaining !== undefined ? `剩余 ${format(remaining)}${window.limit !== undefined ? ` / ${format(window.limit)}` : ''} ${unit}` : window.used !== undefined ? `已用 ${format(window.used)}${window.limit !== undefined ? ` / ${format(window.limit)}` : ''} ${unit}` : `${unit}已用 ${format(percent ?? 0)}%`}</span>
                  {percent !== undefined ? <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-default" role="meter" aria-label={`${unit}剩余比例`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, 100 - percent))}>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, 100 - percent))}%` }} />
                  </div> : null}
                  {percent !== undefined ? <span className="text-muted">剩余 {format(Math.max(0, 100 - percent))}%</span> : null}
                  {window.resetsAt ? <span className="text-muted">{new Date(window.resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置</span> : null}
                </div>;
              }) : <span className="text-xs text-muted">{details === undefined && usageLoading && usageAccountIds.split(',').includes(item.id) ? '正在读取额度…' : details?.quotaAuthRequired ? '额度查询授权不可用，请重新授权' : details?.state === 'expired' ? '授权已过期，请重新授权' : details === null || details?.quotaError || details?.accountError ? '额度读取失败，可刷新重试' : '暂无额度数据'}</span>}
            </div>
          </ListBox.Item>;
        })}
      </ListBox>
      {!accounts.length ? <p className="text-sm text-muted">暂无账户</p> : null}
    </section>
    <section className="grid min-w-0 gap-3" aria-labelledby={`${labelId}-models`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label id={`${labelId}-models`}>模型列表</Label>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" variant="tertiary" className="transform-none! h-7 px-2 text-xs" isDisabled={removing || !account || !visibleModels.length}
          onPress={() => { if (account) selectModels(account.id, visibleModels, true); }}>全选</Button>
        <Button size="sm" variant="tertiary" className="transform-none! h-7 px-2 text-xs" isDisabled={removing || !account || !visibleModels.length}
          onPress={() => { if (account) selectModels(account.id, visibleModels, false); }}>全不选</Button>
        <ToggleButton size="sm" isSelected={onlyFree} onChange={setOnlyFree} className="transform-none! h-7 px-2 text-xs">只看免费</ToggleButton>
        </div>
      </div>
      {account && modelErrors[account.id] ? <p role="status" className="text-xs text-muted">模型信息刷新失败，暂时保留上次结果</p> : null}
      {account && visibleModels.length ? <div role="group" aria-labelledby={`${labelId}-models`} className="flex min-w-0 flex-wrap gap-1.5">
        {visibleModels.map(model => {
          const selected = drafts[account.id]?.[model] ?? !account.excludedModels?.includes(model);
          const catalog = catalogs[account.id];
          return <GatewayModelRow key={`${account.id}:${model}`} id={model}
            name={gatewayModelName(account.auth.kind === 'subscription' ? account.auth.provider : account.preset, model, catalog?.metadata?.[model]?.name ?? catalog?.names?.[model]) ?? model}
            metadata={catalog?.metadata?.[model]} now={modelNow} selected={selected} disabled={removing}
            onChange={value => selectModels(account.id, [model], value)} />;
        })}
      </div> : <p className="text-sm text-muted">{onlyFree ? '暂无已确认免费的模型' : '暂无模型'}</p>}
    </section>
    <AlertDialog.Backdrop isOpen={Boolean(removingAccount)} onOpenChange={open => { if (!open && !removingRef.current) setRemovingAccount(null); }} isDismissable={false} isKeyboardDismissDisabled={removing}>
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.Header><AlertDialog.Heading>删除账户</AlertDialog.Heading></AlertDialog.Header>
          <AlertDialog.Body>
            <p className="break-words">确定删除「{removingAccount?.name}」？删除后，该账户将不再用于网关请求，相关路由配置和本应用保存的登录凭据也会移除。</p>
            {removeError ? <p role="alert" className="mt-2 text-sm text-danger">{removeError}</p> : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button className="transform-none!" variant="tertiary" isDisabled={removing} onPress={() => setRemovingAccount(null)}>取消</Button>
            <Button className="transform-none!" variant="danger" isDisabled={removing || isAddingAccount} onPress={() => void removeAccount()}>{removing ? '删除中…' : '删除账户'}</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  </div>;
}

import { useCallback, useEffect, useState } from 'react';
import { ArrowsRotateRight } from '@gravity-ui/icons';
import {
  Button,
  Checkbox,
  Description,
  Input,
  Label,
  Modal,
  Surface,
  Tabs,
  TextField,
  Toast,
  ToastQueue,
  Tooltip,
} from '@heroui/react';
import {
  fetchConfig,
  getApiBearer,
  hasConfiguredApiBearer,
  isCliBackend,
  refreshJuejinProfile,
  saveConfig,
  setApiBearer,
  type TudConfigView,
} from '@/lib/api';
import { openJuejinLogin } from '@/lib/juejin-client-link';
import { AboutContent } from '@/components/AboutContent';
import { JuejinLoginConsentModal } from '@/components/JuejinLoginConsentModal';
import { StatusBanner } from '@/components/StatusBanner';
import {
  dispatchJuejinLinkChanged,
  type SettingsTabId,
} from '@/lib/shell-events';

const TAB_ITEMS: { id: SettingsTabId; label: string }[] = [
  { id: 'sync', label: '云端同步' },
  { id: 'app', label: '应用' },
  { id: 'about', label: '关于' },
];

export function SettingsPanel({
  activeTab,
  onTabChange,
}: {
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
} = {}) {
  const cliMode = isCliBackend();
  const [toastQueue] = useState(
    () => new ToastQueue({ maxVisibleToasts: 1 }),
  );
  const [uncontrolledTab, setUncontrolledTab] = useState<SettingsTabId>('sync');
  const tab = activeTab ?? uncontrolledTab;
  const setTab = onTabChange ?? setUncontrolledTab;

  // Web dashboard has no pet tab — fall back if a desktop-only tab is requested.
  const resolvedTab: SettingsTabId =
    tab === 'pet' ? 'sync' : tab;

  return (
    <div className="w-full">
      <Toast.Provider placement="top end" queue={toastQueue} />
      <Tabs
        className="w-full text-center"
        selectedKey={resolvedTab}
        onSelectionChange={(key) => setTab(String(key) as SettingsTabId)}
      >
        <Tabs.ListContainer className="m-3 mr-14 w-fit">
          <Tabs.List aria-label="设置分类" className="w-fit">
            {TAB_ITEMS.map((item) => (
              <Tabs.Tab
                className="h-6 w-fit px-3 text-xs font-normal aria-selected:text-accent-foreground"
                id={item.id}
                key={item.id}
              >
                {item.label}
                <Tabs.Indicator className="bg-accent" />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel
          className="h-[50vh] overflow-hidden p-4 text-left font-normal"
          id="sync"
        >
          {resolvedTab === 'sync' &&
            (cliMode ? (
              <CliSyncSettings
                onNotify={(toast) => toastQueue.add(toast)}
                onSaved={() =>
                  toastQueue.add({
                    description: '写入本机 CLI 配置',
                    title: '已保存',
                    variant: 'success',
                  })
                }
              />
            ) : (
              <ServerAuthSettingsPanel
                onLoggedOut={() =>
                  toastQueue.add({
                    title: '已退出登录',
                    variant: 'success',
                  })
                }
                onSaved={() =>
                  toastQueue.add({
                    description: '返回用量页即可拉取对应数据',
                    title: '已保存',
                    variant: 'success',
                  })
                }
              />
            ))}
        </Tabs.Panel>
        <Tabs.Panel className="h-[50vh] overflow-hidden p-4 text-left" id="app">
          {resolvedTab === 'app' && <AppSettingsPanel />}
        </Tabs.Panel>
        <Tabs.Panel className="h-[50vh] overflow-hidden p-4 text-left" id="about">
          {resolvedTab === 'about' && (
            <div className="h-full overflow-y-auto pr-1">
              <AboutContent />
            </div>
          )}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

function CliSyncSettings({
  onSaved,
  onNotify,
}: {
  onSaved: () => void;
  onNotify: (toast: {
    title: string;
    description?: string;
    variant: 'success' | 'danger';
  }) => void;
}) {
  const [config, setConfig] = useState<TudConfigView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchConfig();
      setConfig(data);
      setEnabled(data.juejin.enabled);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载配置失败');
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!config?.juejin.userId) return;
    let cancelled = false;
    void refreshJuejinProfile({ force: false })
      .then((result) => {
        if (!cancelled && result.changed) setConfig(result.config);
      })
      .catch(() => {
        // Keep the login snapshot when the public card is unreachable.
      });
    return () => {
      cancelled = true;
    };
  }, [config?.juejin.userId]);

  const onEnabledChange = async (next: boolean) => {
    const prev = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await saveConfig({ juejin: { enabled: next } });
      setConfig(saved);
      onSaved();
    } catch (e) {
      setEnabled(prev);
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onConfirmLogout = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveConfig({
        juejin: {
          token: null,
          originUserId: null,
          userName: null,
          avatarLarge: null,
        },
      });
      setConfig(saved);
      setConfirmLogoutOpen(false);
      dispatchJuejinLinkChanged();
      onNotify({
        title: '已退出登录',
        variant: 'success',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '退出失败');
      setConfirmLogoutOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-muted">加载配置…</p>;
  }

  const stripQuotes = (value: string) =>
    value.replace(/^['"]+|['"]+$/g, '').trim();
  const userId = config?.juejin.userId ?? null;
  const originUserId = stripQuotes(config?.juejin.originUserId?.trim() || '');
  const userName = config?.juejin.userName?.trim() || '';
  const avatarLarge = config?.juejin.avatarLarge?.trim() || '';
  const hasToken = config?.juejin.hasToken ?? false;
  // Prefer originUserId; legacy plain token (non-jau) can still show as fallback.
  const linkedPlain =
    userId && !userId.startsWith('jau.') ? stripQuotes(userId) : '';
  const displayUserId = originUserId || linkedPlain || null;

  const handleJuejinLogin = () => {
    void openJuejinLogin().then((result) => {
      if (result.ok) return;
      onNotify({
        title: '无法打开掘金登录页',
        description: result.message ?? '请稍后重试',
        variant: 'danger',
      });
    });
  };

  const onRefreshProfile = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await refreshJuejinProfile({ force: true });
      setConfig(result.config);
      if (result.changed) dispatchJuejinLinkChanged();
      onNotify({
        title: result.changed ? '已同步账号资料' : '资料已是最新',
        variant: 'success',
      });
    } catch (e) {
      onNotify({
        title: '同步失败',
        description: e instanceof Error ? e.message : '请稍后重试',
        variant: 'danger',
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      {error && <StatusBanner tone="error" title={error} />}
      <Surface className="rounded-xl p-4" variant="secondary">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm text-foreground">云端同步</h3>
            <p className="mt-1 text-xs text-muted">
              本地 sync 完成后自动上报掘金
            </p>
          </div>
          <Checkbox
            id="cli-juejin-enabled"
            isDisabled={saving}
            isSelected={enabled}
            onChange={(checked) => {
              void onEnabledChange(checked);
            }}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              启用
            </Checkbox.Content>
          </Checkbox>
        </div>

        <div className="mt-4 flex items-start justify-between gap-4 text-sm">
          <div>
            <p className="text-foreground">关联账号</p>
            <p className="mt-1 text-xs text-muted">用于识别云端用量归属</p>
          </div>
          {userId ? (
            <div className="flex min-w-0 items-center gap-2">
              {avatarLarge ? (
                <img
                  alt={userName || '用户头像'}
                  className="size-8 shrink-0 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                  src={avatarLarge}
                  title={userName || undefined}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[13px] text-accent"
                  title={userName || undefined}
                >
                  {(userName || userId).slice(0, 1)}
                </span>
              )}
              <div className="min-w-0 text-right">
                <p
                  className="truncate text-foreground"
                  title={userName || undefined}
                >
                  {userName || '已关联'}
                </p>
                <p
                  className="break-all font-mono text-xs text-muted"
                  title={
                    displayUserId
                      ? undefined
                      : '缺少 originUserId，请重新掘金登录关联'
                  }
                >
                  {displayUserId ?? '缺少用户 ID（请重新登录关联）'}
                </p>
              </div>
              <Tooltip closeDelay={80} delay={100}>
                <Button
                  aria-label="同步资料"
                  className="size-6 min-h-6 min-w-6 shrink-0 p-0 text-muted"
                  isDisabled={saving || refreshing}
                  isIconOnly
                  onPress={() => {
                    void onRefreshProfile();
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <ArrowsRotateRight
                    className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`}
                  />
                </Button>
                <Tooltip.Content placement="bottom">
                  <p>同步资料</p>
                </Tooltip.Content>
              </Tooltip>
            </div>
          ) : (
            <span className="text-muted">未关联</span>
          )}
        </div>

        {enabled && !userId && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
            {hasToken
              ? '尚未通过掘金登录关联账号；关联前不会上报。'
              : '已开启同步但未关联用户 ID，上报将跳过。'}
          </p>
        )}
      </Surface>

      <div className="mt-auto flex justify-end gap-2">
        {userId ? (
          <Button
            isDisabled={saving}
            onPress={() => setConfirmLogoutOpen(true)}
            variant="danger"
          >
            退出登录
          </Button>
        ) : (
          <Button
            isDisabled={saving}
            onPress={() => setConsentOpen(true)}
            variant="primary"
          >
            掘金登录
          </Button>
        )}
      </div>

      <JuejinLoginConsentModal
        isOpen={consentOpen}
        onConfirm={handleJuejinLogin}
        onOpenChange={setConsentOpen}
      />

      <Modal.Backdrop
        isOpen={confirmLogoutOpen}
        onOpenChange={setConfirmLogoutOpen}
        variant="opaque"
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label="关闭" />
            <Modal.Header>
              <Modal.Heading>退出登录</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="text-sm text-muted">
              确认清除本机保存的用户 ID？清除后需重新通过掘金登录关联。
            </Modal.Body>
            <Modal.Footer className="gap-2">
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button
                isDisabled={saving}
                onPress={() => {
                  void onConfirmLogout();
                }}
                variant="danger"
              >
                确认退出
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}

function AppSettingsPanel() {
  const [config, setConfig] = useState<TudConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchConfig()
      .then((data) => {
        if (!cancelled) {
          setConfig(data);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '加载配置失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="text-muted">加载配置…</p>;
  }

  if (error) {
    return <StatusBanner tone="error" title={error} />;
  }

  if (!config) {
    return (
      <p className="text-sm text-muted">
        当前为 Web 模式，设备信息仅在本机 CLI / 桌面端可见。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Surface className="rounded-xl p-4" variant="secondary">
        <h3 className="mb-3 text-sm font-medium text-foreground">设备信息</h3>
        <div className="flex flex-col gap-2 text-sm">
          <InfoRow label="设备 ID" value={config.deviceId} />
          <InfoRow
            label="上报起点"
            value={config.statsSince.slice(0, 19).replace('T', ' ')}
          />
          <InfoRow
            label="上次同步"
            value={
              config.lastSyncAt
                ? new Date(config.lastSyncAt).toLocaleString()
                : '从未'
            }
          />
          <InfoRow
            label="上次上报"
            value={
              config.lastUploadAt
                ? new Date(config.lastUploadAt).toLocaleString()
                : '从未'
            }
          />
        </div>
      </Surface>
    </div>
  );
}

function readStoredApiBearer(): boolean {
  try {
    return Boolean(localStorage.getItem('tud.apiBearer')?.trim());
  } catch {
    return false;
  }
}

function ServerAuthSettingsPanel({
  onLoggedOut,
  onSaved,
}: {
  onLoggedOut: () => void;
  onSaved: () => void;
}) {
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHasToken(hasConfiguredApiBearer());
    setHasStoredToken(readStoredApiBearer());
    setToken('');
  }, []);

  const refreshAuthState = () => {
    setHasToken(hasConfiguredApiBearer());
    setHasStoredToken(readStoredApiBearer());
    setToken('');
  };

  const onSave = () => {
    setSaving(true);
    setError(null);
    try {
      setApiBearer(token.trim() || null);
      refreshAuthState();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onConfirmLogout = () => {
    setError(null);
    try {
      setApiBearer(null);
      refreshAuthState();
      setConfirmLogoutOpen(false);
      onLoggedOut();
    } catch (e) {
      setError(e instanceof Error ? e.message : '退出失败');
      setConfirmLogoutOpen(false);
    }
  };

  const envFallback = Boolean(import.meta.env.VITE_API_BEARER?.trim());
  const showEnvHint = envFallback && !hasStoredToken;

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      {error && <StatusBanner tone="error" title={error} />}
      <p className="text-sm text-muted">
        Web 侧由本机 CLI 上报。业务请求通过 header `x-user-id` 标识账号（`jau.`
        加密 token）；页面会先调 `tud-session`，成功后再拉用量。过渡期也可手动粘贴
        `jau.` token。
      </p>
      <TextField fullWidth name="bearerToken" type="password">
        <Label>加密用户 ID</Label>
        <Input
          fullWidth
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={
            hasToken ? '已配置（留空并保存可清除）' : 'jau.…'
          }
        />
        <Description>
          {showEnvHint
            ? `当前使用开发环境默认身份（${maskToken(getApiBearer() ?? '')}）。保存后将覆盖。`
            : '保存后页面将按此加密身份拉取对应账号数据。'}
        </Description>
      </TextField>

      {!hasToken && !token.trim() && !envFallback && (
        <StatusBanner
          tone="info"
          title="未配置加密用户 ID"
          description="个人用量接口暂时无法定位账号。"
        />
      )}

      <div className="mt-auto flex justify-end gap-2">
        {hasStoredToken && (
          <Button
            isDisabled={saving}
            onPress={() => setConfirmLogoutOpen(true)}
            variant="danger"
          >
            退出登录
          </Button>
        )}
        <Button isDisabled={saving} onPress={onSave} variant="primary">
          {saving ? '保存中…' : '保存设置'}
        </Button>
      </div>

      <Modal.Backdrop
        isOpen={confirmLogoutOpen}
        onOpenChange={setConfirmLogoutOpen}
        variant="opaque"
      >
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label="关闭" />
            <Modal.Header>
              <Modal.Heading>退出登录</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="text-sm text-muted">
              确认清除本机保存的用户 ID？清除后需重新填写或通过掘金登录关联。
            </Modal.Body>
            <Modal.Footer className="gap-2">
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button onPress={onConfirmLogout} variant="danger">
                确认退出
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}

function maskToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 8)}…`;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted">{label}</span>
      <span className="break-all text-right font-mono text-xs">{value}</span>
    </div>
  );
}

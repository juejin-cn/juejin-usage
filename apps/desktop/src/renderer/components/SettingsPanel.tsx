import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  NumberField,
  ProgressBar,
  Select,
  Slider,
  Tabs,
  TextField,
  Toast,
  ToastQueue,
} from '@heroui/react';
import {
  shouldOfferUpdateDownload,
  shouldOfferUpdateRestart,
  type AutoUpdateState,
} from '../../shared/auto-update';
import {
  fetchConfig,
  getApiBearer,
  hasConfiguredApiBearer,
  isCliBackend,
  saveConfig,
  setApiBearer,
  type TudConfigView,
} from '@/lib/api';
import { openJuejinLogin } from '@/lib/juejin-client-link';
import { DESKTOP_PETS } from '@/pets';
import { AboutContent } from '@/components/AboutContent';
import { JuejinLoginConsentModal } from '@/components/JuejinLoginConsentModal';
import { StatusBanner } from '@/components/StatusBanner';
import {
  OPEN_SETTINGS_EVENT,
  dispatchJuejinLinkChanged,
  type OpenSettingsDetail,
  type SettingsTabId,
} from '@/lib/shell-events';

type DesktopSettingsTabId = SettingsTabId;

const TAB_ITEMS: { id: DesktopSettingsTabId; label: string }[] = [
  { id: 'pet', label: '桌面宠物' },
  { id: 'sync', label: '云端同步' },
  { id: 'app', label: '应用' },
  { id: 'about', label: '关于' },
];

export function SettingsPanel({
  activeTab,
  onTabChange,
}: {
  activeTab?: DesktopSettingsTabId;
  onTabChange?: (tab: DesktopSettingsTabId) => void;
} = {}) {
  const cliMode = isCliBackend();
  const [toastQueue] = useState(
    () => new ToastQueue({ maxVisibleToasts: 1 }),
  );
  const [uncontrolledTab, setUncontrolledTab] =
    useState<DesktopSettingsTabId>('pet');
  const tab = activeTab ?? uncontrolledTab;
  const setTab = onTabChange ?? setUncontrolledTab;

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsDetail>).detail;
      if (detail?.loginSuccess) {
        toastQueue.add({
          title: '登录成功',
          variant: 'success',
        });
        dispatchJuejinLinkChanged();
        return;
      }
      if (detail?.loginError) {
        toastQueue.add({
          title: '关联失败',
          description: detail.loginError,
          variant: 'danger',
        });
      }
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [toastQueue]);

  return (
    <div className="w-full">
      <Toast.Provider placement="top end" queue={toastQueue} />
      <Tabs
        className="w-full text-center"
        selectedKey={tab}
        onSelectionChange={(key) => setTab(String(key) as DesktopSettingsTabId)}
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

        <Tabs.Panel className="h-[50vh] min-w-0 overflow-hidden p-4 text-left" id="pet">
          {tab === 'pet' && <DesktopPetSettings />}
        </Tabs.Panel>
        <Tabs.Panel
          className="h-[50vh] overflow-hidden p-4 text-left font-normal"
          id="sync"
        >
          {tab === 'sync' &&
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
          {tab === 'app' && <AppSettingsPanel />}
        </Tabs.Panel>
        <Tabs.Panel className="h-[50vh] overflow-hidden p-4 text-left" id="about">
          {tab === 'about' && (
            <div className="h-full overflow-y-auto pr-1">
              <AboutContent />
            </div>
          )}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

function DesktopPetSettings() {
  const [enabled, setEnabled] = useState(false);
  const [selectedPetId, setSelectedPetId] = useState('hawking');
  const [scale, setScale] = useState(50);
  const [frameIntervalMs, setFrameIntervalMs] = useState(180);
  const [autoMoveEnabled, setAutoMoveEnabled] = useState(true);
  const [autoMoveIntervalMinutes, setAutoMoveIntervalMinutes] = useState(2);
  const saveTimer = useRef<number | null>(null);
  const pendingPreferenceChanges = useRef<{
    scale?: number;
    frameIntervalMs?: number;
    autoMoveEnabled?: boolean;
    autoMoveIntervalMinutes?: number;
  }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const applyPref = (
      pref: {
        enabled: boolean;
        selectedPetId: string;
        scale: number;
        frameIntervalMs: number;
        autoMoveEnabled: boolean;
        autoMoveIntervalMinutes: number;
      },
      skipMotion = false,
    ) => {
      setEnabled(pref.enabled);
      setSelectedPetId(pref.selectedPetId);
      if (skipMotion) return;
      setScale(Math.round(pref.scale * 100));
      setFrameIntervalMs(pref.frameIntervalMs);
      setAutoMoveEnabled(pref.autoMoveEnabled);
      setAutoMoveIntervalMinutes(pref.autoMoveIntervalMinutes);
    };

    void window.tud
      .getDesktopPet()
      .then((pref) => {
        if (!cancelled) applyPref(pref);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : '加载桌面宠物设置失败',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = window.tud.onDesktopPetPreferences((pref) => {
      applyPref(pref, saveTimer.current !== null);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const onChange = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setError(null);
    try {
      await window.tud.setDesktopPetEnabled(next);
    } catch (reason) {
      setEnabled(previous);
      setError(
        reason instanceof Error ? reason.message : '更新桌面宠物设置失败',
      );
    }
  };

  const onSelectedPetChange = async (value: string | number | null) => {
    if (value === null) return;
    const next = String(value);
    if (!DESKTOP_PETS.some((pet) => pet.id === next)) return;
    const previous = selectedPetId;
    setSelectedPetId(next);
    setError(null);
    try {
      await window.tud.setSelectedDesktopPet(next);
    } catch (reason) {
      setSelectedPetId(previous);
      setError(
        reason instanceof Error ? reason.message : '切换桌面宠物失败',
      );
    }
  };

  const savePetPreferences = async (changes: {
    scale?: number;
    frameIntervalMs?: number;
    autoMoveEnabled?: boolean;
    autoMoveIntervalMinutes?: number;
  }) => {
    try {
      const saved = await window.tud.setDesktopPetPreferences(changes);
      setScale(Math.round(saved.scale * 100));
      setFrameIntervalMs(saved.frameIntervalMs);
      setAutoMoveEnabled(saved.autoMoveEnabled);
      setAutoMoveIntervalMinutes(saved.autoMoveIntervalMinutes);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '更新桌面宠物设置失败',
      );
    }
  };

  const schedulePetPreferenceSave = (changes: {
    scale?: number;
    frameIntervalMs?: number;
    autoMoveEnabled?: boolean;
    autoMoveIntervalMinutes?: number;
  }) => {
    pendingPreferenceChanges.current = {
      ...pendingPreferenceChanges.current,
      ...changes,
    };
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      const pending = pendingPreferenceChanges.current;
      pendingPreferenceChanges.current = {};
      void savePetPreferences(pending);
    }, 80);
  };

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const petControlsDisabled = loading || !enabled;

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      {error && <StatusBanner tone="error" title={error} />}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <p className="mb-3 text-sm text-muted">
          显示悬浮宠物。拖动可移动位置，右键可打开菜单。
        </p>
        <Checkbox
          id="desktop-pet-enabled"
          isDisabled={loading}
          isSelected={enabled}
          onChange={(checked) => {
            void onChange(checked);
          }}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            显示桌面宠物
          </Checkbox.Content>
        </Checkbox>
        <div className="mt-5 flex flex-col gap-5 px-4 pb-1">
          <Select
            aria-label="选择桌面宠物"
            isDisabled={petControlsDisabled}
            value={selectedPetId}
            variant="secondary"
            onChange={onSelectedPetChange}
          >
            <Label>宠物形象</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox aria-label="桌面宠物列表">
                {DESKTOP_PETS.map((pet) => (
                  <ListBox.Item
                    id={pet.id}
                    key={pet.id}
                    textValue={pet.displayName}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span>{pet.displayName}</span>
                      <span className="text-xs text-muted">
                        {pet.description}
                      </span>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Slider
            isDisabled={petControlsDisabled}
            maxValue={75}
            minValue={35}
            onChange={(value) => {
              const next = Array.isArray(value) ? (value[0] ?? scale) : value;
              setScale(next);
              schedulePetPreferenceSave({ scale: next / 100 });
            }}
            step={5}
            value={scale}
          >
            <Label>宠物大小</Label>
            <Slider.Output>{`${scale}%`}</Slider.Output>
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
          <Checkbox
            id="desktop-pet-auto-move-enabled"
            isDisabled={petControlsDisabled}
            isSelected={autoMoveEnabled}
            onChange={(checked) => {
              setAutoMoveEnabled(checked);
              void savePetPreferences({ autoMoveEnabled: checked });
            }}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              自动跑动
            </Checkbox.Content>
          </Checkbox>
          <NumberField
            isDisabled={petControlsDisabled || !autoMoveEnabled}
            maxValue={120}
            minValue={1}
            onChange={(value) => {
              if (!Number.isFinite(value)) return;
              const next = Math.min(120, Math.max(1, Math.round(value)));
              setAutoMoveIntervalMinutes(next);
              schedulePetPreferenceSave({ autoMoveIntervalMinutes: next });
            }}
            step={1}
            value={autoMoveIntervalMinutes}
            variant="secondary"
          >
            <Label>跑动间隔</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            <Description>
              宠物空闲 {autoMoveIntervalMinutes} 分钟后，会在当前屏幕内随机自然跑动。
            </Description>
          </NumberField>
          <Slider
            isDisabled={petControlsDisabled}
            maxValue={320}
            minValue={120}
            onChange={(value) => {
              const next = Array.isArray(value)
                ? (value[0] ?? frameIntervalMs)
                : value;
              setFrameIntervalMs(next);
              schedulePetPreferenceSave({ frameIntervalMs: next });
            }}
            step={10}
            value={frameIntervalMs}
          >
            <Label>动作速度</Label>
            <Slider.Output>{`${frameIntervalMs} ms / 帧`}</Slider.Output>
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        </div>
      </div>
    </div>
  );
}

/** CLI：云同步配置（不含开机自启 / 设备信息）。 */
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

  // Deep-link / tray may open settings after writing config — force reload.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsDetail>).detail;
      if (detail?.reloadConfig || detail?.tab === 'sync') {
        void load();
      }
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [load]);

  // Also refresh when the window regains focus (e.g. schema open while modal up).
  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

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
        title: '无法打开浏览器',
        description:
          result.message === 'POPUP_BLOCKED'
            ? '请允许弹窗后重试'
            : (result.message ?? '请稍后重试'),
        variant: 'danger',
      });
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      {error && <StatusBanner tone="error" title={error} />}
      <p className="shrink-0 text-sm text-muted">
        开启后本地 sync 完成会自动上报掘金
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
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
            启用云端同步
          </Checkbox.Content>
        </Checkbox>

        <div className="flex items-start justify-between gap-4 text-sm">
          <span className="shrink-0 text-muted">关联账号</span>
          {userId ? (
            <div className="flex min-w-0 items-center gap-2.5">
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
            </div>
          ) : (
            <span className="text-muted">未关联</span>
          )}
        </div>

        {enabled && !userId && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {hasToken
              ? '尚未通过掘金登录关联账号；关联前不会上报。'
              : '已开启同步但未关联用户 ID，上报将跳过。'}
          </p>
        )}

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

/** 自动更新 + 开机自启 + 设备信息。 */
function AppSettingsPanel() {
  const cliMode = isCliBackend();
  const [config, setConfig] = useState<TudConfigView | null>(null);
  const [openAtLogin, setOpenAtLogin] = useState(true);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [launchHidden, setLaunchHidden] = useState(true);
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

  useEffect(() => {
    let cancelled = false;
    setAutostartLoading(true);
    void window.tud
      .getOpenAtLogin()
      .then((value) => {
        if (!cancelled) {
          setOpenAtLogin(value);
          setAutostartError(null);
        }
      })
      .then(() => {
        if (cancelled) return;
        return window.tud.getLaunchHidden().then((value) => {
          if (!cancelled) setLaunchHidden(value);
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setAutostartError(
            e instanceof Error ? e.message : '加载开机自启设置失败',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setAutostartLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onOpenAtLoginChange = async (next: boolean) => {
    const prev = openAtLogin;
    setOpenAtLogin(next);
    setAutostartError(null);
    try {
      await window.tud.setOpenAtLogin(next);
    } catch (e) {
      setOpenAtLogin(prev);
      setAutostartError(
        e instanceof Error ? e.message : '更新开机自启失败',
      );
    }
  };

  const onLaunchHiddenChange = async (next: boolean) => {
    const prev = launchHidden;
    setLaunchHidden(next);
    try {
      await window.tud.setLaunchHidden(next);
    } catch (e) {
      setLaunchHidden(prev);
      setAutostartError(
        e instanceof Error ? e.message : '更新静默启动设置失败',
      );
    }
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pr-1">
      {error && <StatusBanner tone="error" title={error} />}
      {autostartError && (
        <StatusBanner tone="error" title={autostartError} />
      )}

      {cliMode && (
        <div className="flex flex-col gap-2">
          <Checkbox
            id="desktop-open-at-login"
            isDisabled={autostartLoading}
            isSelected={openAtLogin}
            onChange={(checked) => {
              void onOpenAtLoginChange(checked);
            }}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              开机时自动启动
            </Checkbox.Content>
          </Checkbox>
          {openAtLogin && (
            <>
              <Checkbox
                id="desktop-launch-hidden"
                isDisabled={autostartLoading}
                isSelected={launchHidden}
                onChange={(checked) => {
                  void onLaunchHiddenChange(checked);
                }}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  静默启动
                </Checkbox.Content>
              </Checkbox>
              {launchHidden && (
                <p className="text-xs text-muted">
                  开机后只出现托盘，不弹出主窗口
                </p>
              )}
            </>
          )}
        </div>
      )}

      <AutoUpdateSettings />

      {!loading && config && (
        <Card variant="tertiary" className="rounded-xl shadow-none">
          <Card.Header>
            <Card.Title>设备信息</Card.Title>
          </Card.Header>
          <Card.Content className="flex flex-col gap-2 text-sm">
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
          </Card.Content>
        </Card>
      )}
    </div>
  );
}

function AutoUpdateSettings() {
  const [state, setState] = useState<AutoUpdateState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadPending, setDownloadPending] = useState(false);
  const [installPending, setInstallPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.tud.onAutoUpdateStateChanged((next) => {
      if (!cancelled) {
        setState(next);
        if (next.status !== 'error') setActionError(null);
      }
    });
    void window.tud
      .getAutoUpdateState()
      .then((next) => {
        if (!cancelled) {
          setState(next);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setActionError(
            reason instanceof Error ? reason.message : '读取更新状态失败',
          );
        }
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const check = async () => {
    setActionError(null);
    try {
      setState(await window.tud.checkForUpdates());
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : '检查更新失败',
      );
    }
  };

  const install = async () => {
    setActionError(null);
    setInstallPending(true);
    try {
      await window.tud.installDownloadedUpdate();
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : '重启并安装更新失败',
      );
    } finally {
      setInstallPending(false);
    }
  };

  const download = async () => {
    setActionError(null);
    setDownloadPending(true);
    try {
      setState(await window.tud.downloadAndInstallUpdate());
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : '下载更新失败',
      );
    } finally {
      setDownloadPending(false);
    }
  };

  const status = state?.status ?? 'idle';
  const busy =
    status === 'checking' ||
    status === 'downloading' ||
    status === 'installing';
  const actionPending = downloadPending || installPending;
  const message = updateStatusMessage(state);
  const error = actionError ?? (status === 'error' ? state?.message : null);
  const canDownload = shouldOfferUpdateDownload(status);
  const canRestart = shouldOfferUpdateRestart(status);
  const showCheckAction =
    status !== 'downloading' && !canDownload && !canRestart;

  return (
    <Card className="rounded-xl shadow-none" variant="tertiary">
      <Card.Header>
        <div className="flex w-full items-center justify-between gap-4">
          <Card.Title>应用更新</Card.Title>
          {showCheckAction && (
            <Button
              isDisabled={status === 'unsupported' || busy}
              isPending={status === 'checking'}
              onPress={() => {
                void check();
              }}
              size="sm"
              variant="outline"
            >
              检查更新
            </Button>
          )}
        </div>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        <InfoRow
          label="当前版本"
          value={`v${state?.currentVersion ?? '—'}`}
        />
        {status === 'skipped' && (
          <InfoRow
            label="当前最新版本"
            value={`v${state?.version ?? state?.currentVersion ?? '—'}`}
          />
        )}

        {error && (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>更新失败</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {status === 'downloaded' && state?.message && (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>自动重启未完成</Alert.Title>
              <Alert.Description>{state.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {status === 'downloading' && (
          <ProgressBar
            aria-label="更新下载进度"
            isIndeterminate={state?.percent == null}
            size="sm"
            value={state?.percent ?? 0}
          >
            <Label>下载 v{state?.version}</Label>
            <ProgressBar.Output />
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        )}

        {(message || canDownload || canRestart) && (
          <div className="flex items-center justify-between gap-4">
            {message && <p className="text-xs text-muted">{message}</p>}
            {canDownload ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  isDisabled={actionPending}
                  isPending={downloadPending}
                  onPress={() => {
                    void download();
                  }}
                  size="sm"
                  variant="primary"
                >
                  下载并更新
                </Button>
              </div>
            ) : canRestart ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  isDisabled={status === 'installing' || actionPending}
                  isPending={installPending || status === 'installing'}
                  onPress={() => {
                    void install();
                  }}
                  size="sm"
                  variant="primary"
                >
                  重启并更新
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function updateStatusMessage(state: AutoUpdateState | null): string {
  if (!state) return '正在读取更新状态…';
  switch (state.status) {
    case 'unsupported':
      return state.message ?? '开发环境不支持自动更新';
    case 'checking':
      return '正在检查新版本…';
    case 'available':
      return `发现 v${state.version ?? ''}，等待你选择是否更新`;
    case 'downloading':
      return `正在下载 v${state.version ?? ''}，完成后将自动重启安装`;
    case 'downloaded':
      return state.message
        ? `v${state.version ?? ''} 已下载，可手动重启安装`
        : `v${state.version ?? ''} 已下载，安装前不会中断服务`;
    case 'skipped':
      return '';
    case 'installing':
      return `v${state.version ?? ''} 已下载，正在重启并安装…`;
    case 'not-available':
      return '当前已是最新版本';
    case 'error':
      return '未能完成更新检查，可稍后重试';
    default:
      return '应用启动后会自动检查更新';
  }
}

function readStoredApiBearer(): boolean {
  try {
    return Boolean(localStorage.getItem('tud.apiBearer')?.trim());
  } catch {
    return false;
  }
}

/** 掘金 Server Web：无需云同步，暂用 Token 拉取对应账号数据。 */
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
        Web 侧由本机 CLI 上报。过渡期可填写用户 ID 拉取对应账号数据（后续将改为 cookie 自动识别）。
      </p>
      <TextField fullWidth name="bearerToken" type="password">
        <Label>用户 ID</Label>
        <Input
          fullWidth
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={
            hasToken ? '已配置（留空并保存可清除）' : '用户 ID'
          }
        />
        <Description>
          {showEnvHint
            ? `当前使用开发环境默认用户 ID（${maskToken(getApiBearer() ?? '')}）。保存后将覆盖。`
            : '保存后页面将按此用户 ID 拉取对应账号数据。'}
        </Description>
      </TextField>

      {!hasToken && !token.trim() && !envFallback && (
        <StatusBanner
          tone="info"
          title="未配置用户 ID"
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

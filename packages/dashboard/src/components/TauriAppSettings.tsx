import { Checkbox, Label, ListBox, Select } from '@heroui/react';
import { useEffect, useState } from 'react';
import { getTauriDesktopBridge, type TauriPetPreferences, type TauriStartupSettings } from '@/lib/tauri-desktop';
import { StatusBanner } from './StatusBanner';

/** Keep the application controls in the same order and layout as Electron. */
export function TauriAppSettings() {
  const bridge = getTauriDesktopBridge();
  const [settings, setSettings] = useState<TauriStartupSettings | null>(null);
  const [prefs, setPrefs] = useState<TauriPetPreferences | null>(null);
  const [startupBusy, setStartupBusy] = useState(false);
  const [trayBusy, setTrayBusy] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [trayError, setTrayError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    let receivedStartup = false;
    let receivedPrefs = false;
    const stopStartup = bridge.onStartupSettings(value => {
      receivedStartup = true;
      if (alive) { setSettings(value); setStartupError(null); }
    });
    const stopPrefs = bridge.onPetPreferences(value => {
      receivedPrefs = true;
      if (alive) { setPrefs(value); setTrayError(null); }
    });
    void bridge.getStartupSettings()
      .then(value => { if (alive && !receivedStartup) setSettings(value); })
      .catch(() => { if (alive && !receivedStartup) setStartupError('加载开机自启设置失败'); });
    if (bridge.platform === 'darwin') {
      void bridge.getPetPreferences()
        .then(value => { if (alive && !receivedPrefs) setPrefs(value); })
        .catch(() => { if (alive && !receivedPrefs) setTrayError('加载托盘用量设置失败'); });
    }
    return () => { alive = false; stopStartup(); stopPrefs(); };
  }, [bridge]);

  if (!bridge) return null;
  const updateStartup = async (changes: { openAtLogin?: boolean; launchHidden?: boolean }) => {
    if (startupBusy) return;
    setStartupBusy(true); setStartupError(null);
    try { setSettings(await bridge.setStartupSettings(changes)); }
    catch (reason) { setStartupError(reason instanceof Error ? reason.message : '更新启动设置失败，请重试'); }
    finally { setStartupBusy(false); }
  };
  const updateTray = async (changes: Partial<TauriPetPreferences>) => {
    if (trayBusy) return;
    setTrayBusy(true); setTrayError(null);
    try { setPrefs(await bridge.setPetPreferences(changes)); }
    catch (reason) { setTrayError(reason instanceof Error ? reason.message : '更新托盘用量设置失败，请重试'); }
    finally { setTrayBusy(false); }
  };
  const openAtLogin = settings?.openAtLogin ?? true;
  const launchHidden = settings?.launchHidden ?? true;
  const showTrayUsage = prefs?.showTrayUsage ?? true;
  const startupDisabled = !settings?.supported || startupBusy;
  const trayDisabled = !prefs || trayBusy;

  return (
    <>
      {startupError && <StatusBanner tone="error" title={startupError} />}
      {trayError && <StatusBanner tone="error" title={trayError} />}
      <div className="flex flex-col gap-2">
        <Checkbox id="desktop-open-at-login" isDisabled={startupDisabled} isSelected={openAtLogin}
          onChange={value => { void updateStartup({ openAtLogin: value }); }}>
          <Checkbox.Content>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            开机时自动启动
          </Checkbox.Content>
        </Checkbox>
        {openAtLogin && (
          <>
            <Checkbox id="desktop-launch-hidden" isDisabled={startupDisabled} isSelected={launchHidden}
              onChange={value => { void updateStartup({ launchHidden: value }); }}>
              <Checkbox.Content>
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                静默启动
              </Checkbox.Content>
            </Checkbox>
            {launchHidden && <p className="text-xs text-muted">开机后只出现托盘，不弹出主窗口</p>}
          </>
        )}
        {bridge.platform === 'darwin' && (
          <>
            <Checkbox id="desktop-show-tray-usage" isDisabled={trayDisabled} isSelected={showTrayUsage}
              onChange={value => { void updateTray({ showTrayUsage: value }); }}>
              <Checkbox.Content>
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                在菜单栏托盘显示今日用量
              </Checkbox.Content>
            </Checkbox>
            {showTrayUsage && (
              <div className="mt-2 max-w-xs pl-4">
                <Select aria-label="菜单栏用量显示方式" isDisabled={trayDisabled}
                  value={prefs?.trayUsageMode ?? 'both'} variant="secondary"
                  onChange={value => {
                    if (value === 'both' || value === 'tokens' || value === 'cost') {
                      void updateTray({ trayUsageMode: value });
                    }
                  }}>
                  <Label>显示方式</Label>
                  <Select.Trigger>
                    <Select.Value>{({ selectedText }) => selectedText}</Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox aria-label="菜单栏用量显示方式列表">
                      <ListBox.Item id="both" textValue="Token 和金额">Token 和金额<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="tokens" textValue="仅 Token">仅 Token<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="cost" textValue="仅金额">仅金额<ListBox.ItemIndicator /></ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            )}
          </>
        )}
        {settings && !settings.supported && <p className="text-xs text-muted">开机自启需在 release 应用中配置。</p>}
      </div>
    </>
  );
}

import { Checkbox, Surface } from '@heroui/react';
import { useEffect, useState } from 'react';
import { getTauriDesktopBridge, type TauriPetPreferences, type TauriStartupSettings } from '@/lib/tauri-desktop';

export function TauriAppSettings() {
  const bridge = getTauriDesktopBridge();
  const [settings, setSettings] = useState<TauriStartupSettings | null>(null);
  const [prefs,setPrefs]=useState<TauriPetPreferences|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.getStartupSettings().then(value => { if (alive) setSettings(value); }).catch(() => { if (alive) setError('读取启动设置失败'); });
    void bridge.getPetPreferences().then(value=>{if(alive)setPrefs(value);}).catch(()=>{});
    const stopPet=bridge.onPetPreferences(value=>{if(alive)setPrefs(value);});
    const stop = bridge.onStartupSettings(value => { if (alive) setSettings(value); });
    return () => { alive = false; stop(); stopPet(); };
  }, [bridge]);
  if (!bridge) return null;
  const update = (changes: {openAtLogin?: boolean; launchHidden?: boolean}) => {
    if (busy) return;
    setBusy(true); setError(null);
    void bridge.setStartupSettings(changes).then(setSettings).catch(() => setError('保存启动设置失败，请重试')).finally(() => setBusy(false));
  };
  return <Surface variant="secondary" className="flex flex-col gap-3 rounded-xl p-4">
    <h3 className="text-sm font-medium">启动设置</h3>
    {bridge.platform==='darwin'&&prefs&&<>
      <Checkbox isDisabled={busy} isSelected={prefs.showTrayUsage} onChange={showTrayUsage=>{setBusy(true);void bridge.setPetPreferences({showTrayUsage}).then(setPrefs).catch(()=>setError('保存菜单栏设置失败')).finally(()=>setBusy(false));}}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>在菜单栏显示今日用量</Checkbox.Content></Checkbox>
      {prefs.showTrayUsage&&<label className="text-sm">显示内容<select aria-label="菜单栏用量显示方式" className="ml-2 rounded-lg bg-surface p-2" disabled={busy} value={prefs.trayUsageMode} onChange={event=>{setBusy(true);void bridge.setPetPreferences({trayUsageMode:event.target.value as TauriPetPreferences['trayUsageMode']}).then(setPrefs).catch(()=>setError('保存菜单栏设置失败')).finally(()=>setBusy(false));}}><option value="both">Token 和费用</option><option value="tokens">仅 Token</option><option value="cost">仅费用</option></select></label>}
    </>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Checkbox isDisabled={!settings?.supported || busy} isSelected={settings?.openAtLogin ?? false} onChange={value => update({openAtLogin:value})}>
      <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>开机时自动启动</Checkbox.Content>
    </Checkbox>
    {settings?.openAtLogin && <Checkbox isDisabled={busy} isSelected={settings.launchHidden} onChange={value => update({launchHidden:value})}>
      <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>静默启动</Checkbox.Content>
    </Checkbox>}
    {settings && !settings.supported && <p className="text-xs text-muted">开机自启需在 release 应用中配置。</p>}
  </Surface>;
}

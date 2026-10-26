import { Button, Checkbox } from '@heroui/react';
import { useEffect, useState } from 'react';
import { getTauriDesktopBridge, type TauriPetPreferences } from '@/lib/tauri-desktop';
interface Pet {id:string;displayName:string;source:string;}
interface Catalog {pets:Pet[];invalidPets?:{directory:string;reason:string}[];error?:string;}
async function request<T>(suffix='', body?: object): Promise<T> {
  const result = await fetch(`/functions/tud-desktop-pets${suffix}`, body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : undefined);
  const value=await result.json();if(!result.ok||!value.success)throw new Error(value.message??'宠物操作失败');return value.data;
}
export function TauriPetSettings() {
  const bridge=getTauriDesktopBridge();
  const [prefs,setPrefs]=useState<TauriPetPreferences|null>(null),[catalog,setCatalog]=useState<Catalog>({pets:['hawking','yoyo','click'].map(id=>({id,displayName:id,source:'builtin'}))}),[remote,setRemote]=useState<Catalog>({pets:[]}),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{if(!bridge)return;let alive=true;void bridge.getPetPreferences().then(p=>{if(alive)setPrefs(p);}).catch(()=>{if(alive)setError('读取桌宠设置失败，请重试');});void request<Catalog>().then(c=>{if(alive)setCatalog(c);}).catch(()=>{if(alive)setError('本地服务不可用，暂时无法读取自定义宠物目录');});const stop=bridge.onPetPreferences(p=>{if(alive)setPrefs(p);});return()=>{alive=false;stop();};},[bridge]);
  if(!bridge)return null;
  const run=(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(null);void work().catch(e=>setError(e instanceof Error?e.message:'宠物操作失败')).finally(()=>setBusy(false));};
  const change=(changes:Partial<TauriPetPreferences>)=>run(async()=>setPrefs(await bridge.setPetPreferences(changes)));
  const check=(label:string,key:'enabled'|'autoMoveEnabled'|'syncFeedbackEnabled')=><Checkbox isDisabled={busy||!prefs} isSelected={prefs?.[key]??false} onChange={value=>change({[key]:value})}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{label}</Checkbox.Content></Checkbox>;
  const slider=(label:string,key:'scale'|'frameIntervalMs'|'autoMoveIntervalMinutes'|'syncFeedbackDurationSec',min:number,max:number,step:number)=><label className="flex flex-col gap-1 text-sm">{label}：{prefs?.[key]}<input aria-label={label} type="range" disabled={busy||!prefs} min={min} max={max} step={step} value={prefs?.[key]??min} onChange={event=>setPrefs(current=>current?{...current,[key]:Number(event.target.value)}:current)} onPointerUp={event=>change({[key]:Number(event.currentTarget.value)})} onKeyUp={event=>change({[key]:Number(event.currentTarget.value)})}/></label>;
  return <div className="flex flex-col gap-4">
    {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
    {check('显示桌宠','enabled')}
    <label className="flex flex-col gap-1 text-sm">宠物<select className="rounded-lg bg-surface p-2" disabled={busy||!prefs} value={prefs?.selectedPetId??'hawking'} onChange={event=>change({selectedPetId:event.target.value})}>{catalog.pets.map(p=><option key={p.id} value={p.id}>{p.displayName}（{p.source==='builtin'?'内置':'本地'}）</option>)}</select></label>
    {slider('缩放','scale',0.35,0.75,0.05)}
    {slider('动画帧间隔（毫秒）','frameIntervalMs',120,320,10)}
    {check('自动漫游','autoMoveEnabled')}
    {slider('漫游间隔（分钟）','autoMoveIntervalMinutes',1,120,1)}
    {check('同步增量气泡','syncFeedbackEnabled')}
    {slider('气泡显示时长（秒）','syncFeedbackDurationSec',1,10,1)}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" isDisabled={busy} onPress={()=>run(()=>bridge.openPetDirectory())}>打开宠物目录</Button>
      <Button size="sm" isDisabled={busy} onPress={()=>run(async()=>setCatalog(await request<Catalog>()))}>刷新本地宠物</Button>
      <Button size="sm" isDisabled={busy} onPress={()=>run(async()=>{const value=await request<Catalog>('/remote',{});setRemote(value);if(value.error)setError(value.error);})}>获取社区宠物</Button>
    </div>
    {catalog.invalidPets?.map(p=><p key={p.directory} className="text-xs text-danger">{p.directory}：{p.reason}</p>)}
    {remote.pets.filter(p=>!catalog.pets.some(local=>local.id===p.id)).map(p=><div key={p.id} className="flex items-center justify-between text-sm"><span>{p.displayName}</span><Button size="sm" isDisabled={busy} onPress={()=>run(async()=>{await request('/install',{id:p.id});setCatalog(await request<Catalog>());})}>安装</Button></div>)}
  </div>;
}

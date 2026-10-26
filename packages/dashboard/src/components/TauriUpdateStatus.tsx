import { useEffect, useState } from 'react';
import { useAppToastQueue } from './AppToastContext';
import { Button } from '@heroui/react';
import { getTauriDesktopBridge, type TauriUpdateSnapshot } from '@/lib/tauri-desktop';
function useUpdateStatus() {
  const bridge=getTauriDesktopBridge();
  const [status,setStatus]=useState<TauriUpdateSnapshot|null>(null);
  useEffect(()=>{
    if(!bridge)return;
    let disposed=false,received=false;
    const stop=bridge.onUpdateStatus(next=>{received=true;if(!disposed)setStatus(next);});
    void bridge.getUpdateStatus().then(next=>{if(!disposed&&!received)setStatus(next);}).catch(()=>{});
    return()=>{disposed=true;stop();};
  },[bridge]);
  return {bridge,status};
}
export function TauriUpdateSettings() {
  const {bridge,status}=useUpdateStatus();
  if(!bridge||!status||status.status==='disabled')return null;
  const busy=['checking','downloading','installing'].includes(status.status);
  return <div className="flex items-center justify-between gap-3 text-sm"><span>版本 {status.currentVersion}</span><Button size="sm" variant="tertiary" isDisabled={busy} onPress={()=>{void bridge.checkForUpdates().catch(()=>{});}}>{status.status==='checking'?'正在检查…':'检查更新'}</Button></div>;
}
export function TauriUpdateNotice() {
  const {bridge,status}=useUpdateStatus();
  const queue=useAppToastQueue();
  useEffect(()=>{if(status?.status==='notAvailable')queue.add({title:'当前已是最新版本',variant:'success'});},[status,queue]);
  if(!bridge||!status||!['available','downloading','installing','error'].includes(status.status))return null;
  const available=Boolean(status.availableVersion)&&['available','error'].includes(status.status);
  const message=status.status==='available'?`发现新版本 ${status.availableVersion}`:status.status==='downloading'?'正在下载并验证更新…':status.status==='installing'?'正在安装，即将重启…':status.status==='notAvailable'?'当前已是最新版本':status.message;
  return <div role="status" className="z-50 flex shrink-0 items-center justify-between gap-3 border-b border-separator bg-surface px-4 py-2 text-sm text-foreground"><span>{message}</span>{available&&<Button size="sm" variant="tertiary" onPress={()=>{void bridge.installUpdate().catch(()=>{});}}>安装并重启</Button>}{status.status==='error'&&!available&&<Button size="sm" variant="tertiary" onPress={()=>{void bridge.checkForUpdates().catch(()=>{});}}>重试</Button>}</div>;
}

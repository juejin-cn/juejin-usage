import { useEffect, useState } from 'react';
import { petRequest } from '@/lib/tauri-pets';

/** Same idle-frame crop as Electron's PetSelectPreview; assets stay in the native bundle. */
export function TauriPetSelectPreview({petId,spritesheetUrl}:{petId:string;spritesheetUrl?:string}) {
  const [url,setUrl]=useState<string|null>(null);
  useEffect(()=>{
    let alive=true;
    setUrl(null);
    if(spritesheetUrl)setUrl(spritesheetUrl);
    else if(['hawking','yoyo','click'].includes(petId))setUrl(`/pets/${petId}.webp`);
    else void petRequest<{dataUrl:string}>(`/sprite?id=${encodeURIComponent(petId)}`)
      .then(value=>{if(alive)setUrl(value.dataUrl);}).catch(()=>{});
    return()=>{alive=false;};
  },[petId,spritesheetUrl]);
  return <span aria-hidden className="shrink-0 overflow-hidden rounded-sm bg-muted/40" style={{
    width:32,height:35,backgroundImage:url?`url(${JSON.stringify(url)})`:undefined,
    backgroundRepeat:'no-repeat',backgroundSize:`256px ${208*11/6}px`,backgroundPosition:'0 0',
  }} />;
}

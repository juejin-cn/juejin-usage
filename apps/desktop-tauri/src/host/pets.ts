import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const builtin = ['hawking','yoyo','click'].map(id => ({id,displayName:id[0].toUpperCase()+id.slice(1),source:'builtin'}));
export function createPetHandler(directory: string, hostKey: string, resources = join(dirname(fileURLToPath(import.meta.url)), '../pet-resources')) {
  let installing = false;
  const load = (name: string) => import(pathToFileURL(join(resources, `${name}.js`)).href);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/functions/tud-desktop-pets')) return false;
    res.setHeader('content-type','application/json');
    const send = (status: number, body: unknown) => { res.statusCode=status;res.end(JSON.stringify(body)); };
    if (!hostKey || req.headers['x-tud-host-key'] !== hostKey) { send(403,{success:false});return true; }
    try {
      const scanner = await load('desktop-pet-scanner');
      const scan = () => scanner.scanDesktopPetDirectory(directory);
      if (req.method === 'GET' && url.pathname === '/functions/tud-desktop-pets') {
        const {catalog} = await scan(); send(200,{success:true,data:{...catalog,pets:[...builtin,...catalog.pets]}});
      } else if (req.method === 'GET' && url.pathname === '/functions/tud-desktop-pets/sprite') {
        const {spritesheets} = await scan();
        const path = spritesheets.get(url.searchParams.get('id'));
        if (!path) {send(404,{success:false});return true;}
        send(200,{success:true,data:{dataUrl:`data:image/webp;base64,${(await readFile(path)).toString('base64')}`}});
      } else if (req.method === 'POST' && url.pathname === '/functions/tud-desktop-pets/remote') {
        const {catalog}=await scan();
        const remote=await load('desktop-pet-remote');
        const result=await remote.fetchRemoteDesktopPets({installedIds:new Set([...builtin,...catalog.pets].map(p=>p.id)),force:true});
        send(200,{success:true,data:result});
      } else if (req.method === 'POST' && url.pathname === '/functions/tud-desktop-pets/install') {
        let text=''; for await (const chunk of req) {text+=chunk;if(text.length>4096)throw new Error('请求过大');}
        const {id} = JSON.parse(text);
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('宠物 ID 无效');
        if (installing) {send(409,{success:false,message:'已有安装正在进行'});return true;}
        installing=true;
        try { const remote=await load('desktop-pet-remote');await remote.installRemoteDesktopPet(id,directory); }
        finally {installing=false;}
        send(200,{success:true});
      } else send(404,{success:false});
    } catch {send(500,{success:false,message:'宠物操作失败，请检查宠物包或网络后重试'});}
    return true;
  };
}

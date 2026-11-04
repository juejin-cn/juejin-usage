import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetTriple } from './platform.mjs';
/** Electron-compatible names, so the download page keeps matching `arm64.dmg` / `Setup *.exe`. */
export function releaseName(name, target, product, version) {
  const sig = name.endsWith('.sig') ? '.sig' : '';
  const base = sig ? name.slice(0, -sig.length) : name;
  const arch = target.startsWith('aarch64-') ? '-arm64' : '';
  let renamed;
  if (base.endsWith('.dmg')) renamed = `${product}-${version}${arch}.dmg`;
  else if (base.endsWith('.app.tar.gz')) renamed = `${product}-${version}${arch}-mac.app.tar.gz`;
  else if (base.endsWith('-setup.exe')) renamed = `${product} Setup ${version}.exe`;
  else if (base.endsWith('.AppImage')) renamed = `${product}-${version}${arch}.AppImage`;
  else if (base.endsWith('.deb')) renamed = `${product}-${version}${arch}.deb`;
  else return null;
  return renamed + sig;
}
export function collectArtifacts(app, profile='debug') {
  if(!['debug','release'].includes(profile))throw new Error('Unknown build profile');
  const target=targetTriple();
  const version=JSON.parse(readFileSync(join(app,'package.json'),'utf8')).version;
  const product=JSON.parse(readFileSync(join(app,'src-tauri/tauri.conf.json'),'utf8')).productName||'Juejin Usage';
  const root=join(app,'src-tauri/target',profile,'bundle');
  const out=join(app,'artifacts');rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
  const files=[];
  function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,item.name);
    if(item.isDirectory()){if(!item.name.endsWith('.app'))walk(path);continue;}
    const filename=releaseName(item.name,target,product,version);
    if(!filename)continue;
    if(files.some(f=>f.filename===filename))throw new Error(`Duplicate artifact name: ${filename}`);
    copyFileSync(path,join(out,filename));
    files.push({filename,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
  }}walk(root);
  if(files.length===0)throw new Error('No installer artifacts found');
  files.sort((a,b)=>a.filename.localeCompare(b.filename));
  writeFileSync(join(out,'artifacts.json'),JSON.stringify({version,target,profile,files},null,2)+'\n');
  writeFileSync(join(out,'SHA256SUMS'),files.map(f=>`${f.sha256}  ${f.filename}`).join('\n')+'\n');
  return out;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(collectArtifacts(fileURLToPath(new URL('..',import.meta.url)),process.argv[2]||'debug'));

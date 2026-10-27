import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const app=fileURLToPath(new URL('..',import.meta.url));
const profile=process.argv[2]||'debug';
if(!['debug','release'].includes(profile))throw new Error('Invalid profile');
const bundles=join(app,'src-tauri/target',profile,'bundle');
function files(dir,name,result=[]){for(const item of readdirSync(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())files(path,name,result);else if(item.name===name)result.push(path);}return result;}
function test(root,node){execFileSync(process.execPath,[join(app,'scripts/test-staged.mjs')],{stdio:'inherit',env:{...process.env,TUD_STAGED_ROOT:root,TUD_STAGED_NODE:node}});}
if(process.platform==='darwin') {
  const bundle=join(bundles,'macos/Juejin Usage Tauri.app');
  assert.equal(existsSync(join(bundle,'Contents/MacOS/read-daily')),false,'Headless validation tool must not ship with the app');
  execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
  test(join(bundle,'Contents/Resources/node-app'),join(bundle,'Contents/MacOS/jusage-node'));
} else {
  const temp=mkdtempSync(join(tmpdir(),'jusage-installer-'));
  try {
    if(process.platform==='linux'){
      const dir=join(bundles,'deb');const deb=readdirSync(dir).filter(name=>name.endsWith('.deb'));
      if(deb.length!==1)throw new Error('Expected one deb');
      execFileSync('dpkg-deb',['--extract',join(dir,deb[0]),temp],{stdio:'inherit'});
    }else if(process.platform==='win32'){
      const dir=join(bundles,'nsis');const exe=readdirSync(dir).filter(name=>name.endsWith('-setup.exe'));
      if(exe.length!==1)throw new Error('Expected one NSIS installer');
      const sevenZip=join(process.env.ProgramFiles||'C:/Program Files','7-Zip/7z.exe');
      execFileSync(existsSync(sevenZip)?sevenZip:'7z',['x',join(dir,exe[0]),`-o${temp}`,'-y'],{stdio:'ignore'});
    }else throw new Error('Unsupported package platform');
    const manifests=files(temp,'runtime.json'),nodes=files(temp,process.platform==='win32'?'jusage-node.exe':'jusage-node');
    assert.equal(files(temp,process.platform==='win32'?'read-daily.exe':'read-daily').length,0,'Headless validation tool must not ship');
    if(manifests.length!==1||nodes.length!==1)throw new Error('Installer is missing an unambiguous Node runtime');
    test(join(manifests[0],'..'),nodes[0]);
  }finally{rmSync(temp,{recursive:true,force:true});}
}

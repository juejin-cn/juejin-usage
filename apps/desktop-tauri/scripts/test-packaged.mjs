import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
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
function sha256(path){return createHash('sha256').update(readFileSync(path)).digest('hex');}
function plistString(plist,key){
  const match=plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  if(!match)throw new Error(`hdiutil attach did not return ${key}`);
  return match[1].replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>');
}
function attachDmg(dmg,mountRoot){
  const plist=execFileSync('hdiutil',['attach','-readonly','-nobrowse','-plist','-mountRandom',mountRoot,dmg],{encoding:'utf8'});
  return {device:plistString(plist,'dev-entry'),mount:plistString(plist,'mount-point')};
}
function detachDmg(device){
  try{execFileSync('hdiutil',['detach',device],{stdio:'ignore'});}
  catch{execFileSync('hdiutil',['detach','-force',device],{stdio:'ignore'});}
}
function checkFinderLayout(volume,appName){
  const script=`on run argv
  set volumeName to item 1 of argv
  set applicationName to item 2 of argv
  tell application "Finder"
    try
      tell disk volumeName to open
    end try
    repeat with attempt from 1 to 10
      try
        tell disk volumeName
          update every item
          tell container window
            set windowBounds to bounds
          end tell
          set appPosition to position of item applicationName
          set applicationsPosition to position of item "Applications"
        end tell
        return (item 1 of windowBounds as text) & "|" & (item 2 of windowBounds as text) & "|" & (item 3 of windowBounds as text) & "|" & (item 4 of windowBounds as text) & "|" & (item 1 of appPosition as text) & "|" & (item 2 of appPosition as text) & "|" & (item 1 of applicationsPosition as text) & "|" & (item 2 of applicationsPosition as text)
      on error errorMessage number errorNumber
        if attempt is 10 then error errorMessage number errorNumber
        delay 1
      end try
    end repeat
  end tell
end run`;
  const output=execFileSync('/usr/bin/osascript',['-e',script,volume,appName],{encoding:'utf8'}).trim();
  const values=output.split('|').map(Number);
  assert.equal(values.length,8,`Unexpected Finder layout output: ${output}`);
  const [left,top,right,bottom,appX,appY,applicationsX,applicationsY]=values;
  assert.equal(right-left,660,'DMG Finder window width');
  assert.equal(bottom-top,400,'DMG Finder window height');
  assert.deepEqual([appX,appY],[180,170],'DMG app icon position');
  assert.deepEqual([applicationsX,applicationsY],[480,170],'DMG Applications icon position');
}
function testDmgLayout(){
  const dir=join(bundles,'dmg');
  const dmgs=readdirSync(dir).filter(name=>name.endsWith('.dmg'));
  if(dmgs.length!==1)throw new Error('Expected one final macOS DMG');
  const sourceBackground=join(app,'src-tauri/resources/dmg/background.png');
  const mountRoot=mkdtempSync(join(tmpdir(),'jusage-dmg-mount-'));
  let attached;
  try{
    attached=attachDmg(join(dir,dmgs[0]),mountRoot);
    const appName=readdirSync(attached.mount).find(name=>name.endsWith('.app'));
    assert.ok(appName,'DMG is missing the application bundle');
    const background=join(attached.mount,'.background','background.png');
    assert.equal(sha256(background),sha256(sourceBackground),'DMG background image');
    const applications=join(attached.mount,'Applications');
    assert.equal(lstatSync(applications).isSymbolicLink(),true,'Applications link');
    assert.equal(readlinkSync(applications),'/Applications','Applications link target');
    const requireFinderLayout=profile==='release'&&(process.env.CI==='true'||process.env.TUD_REQUIRE_DMG_LAYOUT==='true');
    if(requireFinderLayout)assert.equal(existsSync(join(attached.mount,'.DS_Store')),true,'DMG Finder metadata');
    const volume=attached.mount.split('/').at(-1);
    try{checkFinderLayout(volume,appName);}
    catch(error){
      if(requireFinderLayout)throw error;
      console.warn(`[desktop-tauri:test] Finder layout check skipped: ${error.message}`);
    }
  }finally{
    if(attached)detachDmg(attached.device);
    rmSync(mountRoot,{recursive:true,force:true});
  }
}
if(process.platform==='darwin') {
  const macos=join(bundles,'macos');
  const apps=readdirSync(macos).filter(name=>name.endsWith('.app'));
  if(apps.length!==1)throw new Error('Expected one macOS application bundle');
  const bundle=join(macos,apps[0]);
  assert.equal(existsSync(join(bundle,'Contents/MacOS/read-daily')),false,'Headless validation tool must not ship with the app');
  execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
  test(join(bundle,'Contents/Resources/node-app'),join(bundle,'Contents/MacOS/jusage-node'));
  testDmgLayout();
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

import { nativeBuildEnvironment } from './signing-env.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const app=fileURLToPath(new URL('..',import.meta.url));
const cli=fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js',import.meta.url));
// Seal candidate bundles with an ad-hoc signature. This is not Developer ID
// signing or notarization; explicit release credentials take precedence.
const env=nativeBuildEnvironment(process.env,process.platform,process.argv.includes('--debug'));
// Do not collect stale updater archives/signatures from a previous build.
const profile=process.argv.includes('--debug')?'debug':'release';
const bundleRoot=join(app,'src-tauri/target',profile,'bundle');

// Tauri's DMG bundling runs a generated bundle_dmg.sh whose hdiutil detach
// gives up after 3 retries (~6s). GitHub macOS runners frequently keep the
// interstitial volume busy longer, which surfaces as flaky "couldn't eject
// diskX - Resource busy" failures. Detect that step from the filesystem
// (bundle_dmg.sh exists but no .dmg was produced) rather than from the
// error message, and retry the bundle round after force-unloading any
// still-mounted interstitial volume.
const isMac=process.platform==='darwin';
function isDmgStepFailure(){
  const dmgDir=join(bundleRoot,'dmg');
  if(!existsSync(dmgDir)) return false;
  const files=readdirSync(dmgDir);
  return files.includes('bundle_dmg.sh')&&!files.some(f=>f.endsWith('.dmg'));
}
function cleanupMountedVolumes(){
  if(!isMac) return;
  const out=spawnSync('hdiutil',['info','-plist'],{encoding:'utf8'});
  const volumes=[...(out.stdout||'').matchAll(/<string>(\/Volumes\/[^<]+)<\/string>/g)].map(m=>m[1]);
  for(const volume of volumes){
    if(!/Usage|Tauri/i.test(volume)) continue;
    const detach=spawnSync('hdiutil',['detach',volume,'-force'],{encoding:'utf8'});
    console.log(`[desktop-tauri:build] ${detach.status===0?'Unloaded':'Force-unload failed for'} ${volume}`);
  }
}
function runBundle(){
  execFileSync(process.execPath,[cli,'build','--features','custom-protocol',...process.argv.slice(2)],{cwd:app,env,stdio:'inherit'});
}
rmSync(bundleRoot,{recursive:true,force:true});
try{
  runBundle();
}catch(error){
  if(!isMac||!isDmgStepFailure()) throw error;
  cleanupMountedVolumes();
  console.log('[desktop-tauri:build] DMG bundling hit a busy interstitial volume; retrying the bundle round');
  runBundle();
}

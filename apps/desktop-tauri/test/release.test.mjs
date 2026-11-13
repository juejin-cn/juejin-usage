import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { targetTriple, externalNodeName } from '../scripts/platform.mjs';
import { syncVersion } from '../scripts/sync-version.mjs';
import { collectArtifacts, releaseName } from '../scripts/collect-artifacts.mjs';

test('native targets match Node platform/arch and reject cross-architecture staging', () => {
  assert.equal(targetTriple('darwin','arm64',null),'aarch64-apple-darwin');
  assert.equal(targetTriple('darwin','x64',null),'x86_64-apple-darwin');
  assert.equal(targetTriple('win32','x64',null),'x86_64-pc-windows-msvc');
  assert.equal(targetTriple('linux','x64',null),'x86_64-unknown-linux-gnu');
  assert.throws(()=>targetTriple('darwin','arm64','x86_64-apple-darwin'),/matching native runner/);
  assert.throws(()=>targetTriple('linux','arm',null),/Unsupported/);
  assert.equal(externalNodeName('x86_64-pc-windows-msvc','win32'),'jusage-node-x86_64-pc-windows-msvc.exe');
});
function fixture(t) {
  const app=mkdtempSync(join(tmpdir(),'jusage-release-'));t.after(()=>rmSync(app,{recursive:true,force:true}));
  mkdirSync(join(app,'src-tauri'),{recursive:true});writeFileSync(join(app,'package.json'),JSON.stringify({version:'1.2.3'}));
  writeFileSync(join(app,'src-tauri/tauri.conf.json'),JSON.stringify({version:'1.0.0'}));
  writeFileSync(join(app,'src-tauri/Cargo.toml'),'[package]\nname = "jusage-desktop-tauri"\nversion = "1.0.0"\n');
  writeFileSync(join(app,'src-tauri/Cargo.lock'),'[[package]]\nname = "jusage-desktop-tauri"\nversion = "1.0.0"\n');
  return app;
}
test('version sync checks all native manifests against the app package', t => {
  const app=fixture(t);assert.throws(()=>syncVersion(app,true),/out of sync/);
  assert.equal(syncVersion(app),'1.2.3');assert.equal(syncVersion(app,true),'1.2.3');
  assert.match(readFileSync(join(app,'src-tauri/Cargo.lock'),'utf8'),/version = "1.2.3"/);
  for(const name of ['tauri.conf.json','Cargo.toml','Cargo.lock']) {const path=join(app,'src-tauri',name);writeFileSync(path,readFileSync(path,'utf8').replace(/\n/g,'\r\n'));}
  assert.equal(syncVersion(app,true),'1.2.3');
});
test('release names match Electron download-page patterns', () => {
  assert.equal(releaseName('App_1.2.3_aarch64.dmg','aarch64-apple-darwin','Juejin Usage','1.2.3'),'Juejin Usage-1.2.3-arm64.dmg');
  assert.equal(releaseName('App_1.2.3_x64.dmg','x86_64-apple-darwin','Juejin Usage','1.2.3'),'Juejin Usage-1.2.3.dmg');
  assert.equal(releaseName('App.app.tar.gz','aarch64-apple-darwin','Juejin Usage','1.2.3'),'Juejin Usage-1.2.3-arm64-mac.app.tar.gz');
  assert.equal(releaseName('App_1.2.3_x64-setup.exe','x86_64-pc-windows-msvc','Juejin Usage','1.2.3'),'Juejin Usage Setup 1.2.3.exe');
  assert.equal(releaseName('App_1.2.3_x64-setup.exe.sig','x86_64-pc-windows-msvc','Juejin Usage','1.2.3'),'Juejin Usage Setup 1.2.3.exe.sig');
  assert.equal(releaseName('notes.txt','aarch64-apple-darwin','Juejin Usage','1.2.3'),null);
});
test('candidate collector assigns Electron-compatible names and content hashes', t => {
  const app=fixture(t),bundle=join(app,'src-tauri/target/debug/bundle/dmg');mkdirSync(bundle,{recursive:true});
  writeFileSync(join(app,'src-tauri/tauri.conf.json'),JSON.stringify({productName:'Juejin Usage',version:'1.2.3'}));
  writeFileSync(join(bundle,'App_1.2.3.dmg'),'installer');writeFileSync(join(bundle,'unrelated.txt'),'private');
  const expected=releaseName('App_1.2.3.dmg',targetTriple(),'Juejin Usage','1.2.3');
  const out=collectArtifacts(app);const meta=JSON.parse(readFileSync(join(out,'artifacts.json'),'utf8'));
  assert.equal(meta.files.length,1);assert.equal(meta.files[0].filename,expected);
  assert.equal(meta.files[0].sha256.length,64);assert.match(readFileSync(join(out,'SHA256SUMS'),'utf8'),new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.throws(()=>collectArtifacts(app,'other'),/profile/);
});

test('collector ignores intermediate DMGs left after a failed detach', t => {
  const app=fixture(t),root=join(app,'src-tauri/target/debug/bundle');
  mkdirSync(join(root,'macos'),{recursive:true});
  writeFileSync(join(root,'macos/rw.123.Juejin Usage.dmg'),'unfinished');
  assert.throws(()=>collectArtifacts(app),/No installer artifacts/);
  mkdirSync(join(root,'dmg'),{recursive:true});
  writeFileSync(join(root,'dmg/App_1.2.3.dmg'),'finished');
  const out=collectArtifacts(app);
  const meta=JSON.parse(readFileSync(join(out,'artifacts.json'),'utf8'));
  assert.equal(meta.files.length,1);
  assert.equal(readFileSync(join(out,meta.files[0].filename),'utf8'),'finished');
  writeFileSync(join(root,'dmg/Another_1.2.3.dmg'),'ambiguous');
  assert.throws(()=>collectArtifacts(app),/Duplicate artifact name/);
});

test('macOS DMG keeps the checked-in Finder layout configuration', () => {
  const config=JSON.parse(readFileSync(fileURLToPath(new URL('../src-tauri/tauri.conf.json',import.meta.url)),'utf8'));
  const dmg=config.bundle?.macOS?.dmg;
  assert.deepEqual(dmg,{
    background:'resources/dmg/background.png',
    windowSize:{width:660,height:400},
    appPosition:{x:180,y:170},
    applicationFolderPosition:{x:480,y:170},
  });
  assert.equal(existsSync(fileURLToPath(new URL('../src-tauri/resources/dmg/background.png',import.meta.url))),true);
});

test('release updater is opt-in and requires a valid public key with HTTPS endpoint', async () => {
  const {releaseConfig}=await import('../scripts/release-config.mjs');
  assert.deepEqual(releaseConfig({},'darwin'),{});
  assert.throws(()=>releaseConfig({TUD_UPDATER_URL:'https://example.com/latest.json'}),/both/);
  const raw=Buffer.alloc(42);raw.write('Ed');
  const key=Buffer.from(`untrusted comment: test fixture\n${raw.toString('base64')}\n`).toString('base64');
  const env={TUD_UPDATER_PUBLIC_KEY:key,TUD_UPDATER_URL:'https://example.com/latest.json'};
  const config=releaseConfig(env,'linux');assert.equal(config.bundle.createUpdaterArtifacts,true);
  assert.deepEqual(config.bundle.targets,['deb','appimage']);assert.equal(config.plugins.updater.pubkey,key);
  assert.throws(()=>releaseConfig({...env,TUD_UPDATER_URL:'http://example.com/latest.json'}),/HTTPS/);
  assert.throws(()=>releaseConfig({...env,TUD_UPDATER_PUBLIC_KEY:'fake'}),/public key/);
  const beta={...env,TUD_RELEASE_CHANNEL:'beta',TUD_UPDATER_URL:'https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri-beta/latest.json'};
  const isolated=releaseConfig(beta,'darwin');
  assert.equal(isolated.identifier,'com.juejin.jusage.desktop-tauri.beta');
  assert.equal(isolated.productName,'Juejin Usage');
  assert.throws(()=>releaseConfig({...env,TUD_RELEASE_CHANNEL:'beta'}),/isolated/);
  assert.throws(()=>releaseConfig({TUD_RELEASE_CHANNEL:'beta'}),/explicit/);
  assert.throws(()=>releaseConfig({...env,TUD_RELEASE_CHANNEL:'typo'}),/Unknown/);
  assert.equal(releaseConfig(env,'darwin').identifier,undefined);
  const stable={...env,TUD_RELEASE_CHANNEL:'stable',TUD_UPDATER_URL:'https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/tauri/latest.json'};
  assert.equal(releaseConfig(stable,'darwin').identifier,undefined);
  assert.throws(()=>releaseConfig({...env,TUD_RELEASE_CHANNEL:'stable'}),/releases\/tauri/);
  assert.throws(()=>releaseConfig({TUD_RELEASE_CHANNEL:'stable'}),/explicit/);
});

test('prepare-release accepts only stable semver', async () => {
  const {spawnSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const script=fileURLToPath(new URL('../scripts/prepare-release.mjs',import.meta.url));
  const bad=spawnSync(process.execPath,[script,'1.0.0-beta.1'],{encoding:'utf8'});
  assert.notEqual(bad.status,0);
  assert.match(bad.stderr+bad.stdout,/stable version/);
});

test('update manifest refuses unsigned or mixed-version candidates', async t => {
  const {updateManifest}=await import('../scripts/update-manifest.mjs');
  const root=fixture(t);
  assert.throws(()=>updateManifest(root,'http://example.com/releases','1.2.3'),/HTTPS/);
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3'),/four/);
  const crypto=await import('node:crypto');
  const targets={'aarch64-apple-darwin':'.app.tar.gz','x86_64-apple-darwin':'.app.tar.gz','x86_64-pc-windows-msvc':'-setup.exe','x86_64-unknown-linux-gnu':'.AppImage'};
  for(const [target,suffix] of Object.entries(targets)){
    if(target==='x86_64-unknown-linux-gnu') {
      assert.equal(Object.keys(updateManifest(root,'https://example.com/releases/tauri-v1.2.3','1.2.3','macos-windows').platforms).length,3);
      assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3'),/four/);
    } else {
      assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3','macos-windows'),/Both macOS/);
    }
    const dir=join(root,target);mkdirSync(dir);const name=`${target}-client${suffix}`;
    const files=[{filename:name,body:'package'},{filename:`${name}.sig`,body:'signature'}].map(f=>{writeFileSync(join(dir,f.filename),f.body);return{filename:f.filename,sha256:crypto.createHash('sha256').update(f.body).digest('hex')};});
    writeFileSync(join(dir,'artifacts.json'),JSON.stringify({version:'1.2.3',profile:'release',target,files}));
  }
  assert.equal(Object.keys(updateManifest(root,'https://example.com/releases/tauri-v1.2.3','1.2.3').platforms).length,4);
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3','macos-windows'),/Unexpected target/);
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3','typo'),/Unknown target/);
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.4'),/Mixed/);
  writeFileSync(join(root,'aarch64-apple-darwin/aarch64-apple-darwin-client.app.tar.gz'),'tampered');
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3'),/checksum/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { targetTriple, externalNodeName } from '../scripts/platform.mjs';
import { syncVersion } from '../scripts/sync-version.mjs';
import { collectArtifacts } from '../scripts/collect-artifacts.mjs';

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
test('candidate collector assigns target-specific names and content hashes', t => {
  const app=fixture(t),bundle=join(app,'src-tauri/target/debug/bundle/dmg');mkdirSync(bundle,{recursive:true});
  writeFileSync(join(bundle,'client.dmg'),'installer');writeFileSync(join(bundle,'unrelated.txt'),'private');
  const out=collectArtifacts(app);const meta=JSON.parse(readFileSync(join(out,'artifacts.json'),'utf8'));
  assert.equal(meta.files.length,1);assert.match(meta.files[0].filename,/-client\.dmg$/);
  assert.equal(meta.files[0].sha256.length,64);assert.match(readFileSync(join(out,'SHA256SUMS'),'utf8'),/client.dmg/);
  assert.throws(()=>collectArtifacts(app,'other'),/profile/);
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
});

test('update manifest refuses unsigned or mixed-version candidates', async t => {
  const {updateManifest}=await import('../scripts/update-manifest.mjs');
  const root=fixture(t);
  assert.throws(()=>updateManifest(root,'http://example.com/releases','1.2.3'),/HTTPS/);
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3'),/four/);
  const crypto=await import('node:crypto');
  const targets={'aarch64-apple-darwin':'.app.tar.gz','x86_64-apple-darwin':'.app.tar.gz','x86_64-pc-windows-msvc':'-setup.exe','x86_64-unknown-linux-gnu':'.AppImage'};
  for(const [target,suffix] of Object.entries(targets)){
    const dir=join(root,target);mkdirSync(dir);const name=`${target}-client${suffix}`;
    const files=[{filename:name,body:'package'},{filename:`${name}.sig`,body:'signature'}].map(f=>{writeFileSync(join(dir,f.filename),f.body);return{filename:f.filename,sha256:crypto.createHash('sha256').update(f.body).digest('hex')};});
    writeFileSync(join(dir,'artifacts.json'),JSON.stringify({version:'1.2.3',profile:'release',target,files}));
  }
  assert.equal(Object.keys(updateManifest(root,'https://example.com/releases/tauri-v1.2.3','1.2.3').platforms).length,4);
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.4'),/Mixed/);
  writeFileSync(join(root,'aarch64-apple-darwin/aarch64-apple-darwin-client.app.tar.gz'),'tampered');
  assert.throws(()=>updateManifest(root,'https://example.com/releases','1.2.3'),/checksum/);
});

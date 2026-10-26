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

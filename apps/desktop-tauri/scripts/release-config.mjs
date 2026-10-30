import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseConfig(env=process.env,platform=process.platform) {
  const key=env.TUD_UPDATER_PUBLIC_KEY?.trim(), endpoint=env.TUD_UPDATER_URL?.trim();
  if(Boolean(key)!==Boolean(endpoint))throw new Error('Set both TUD_UPDATER_PUBLIC_KEY and TUD_UPDATER_URL, or neither');
  const config={};
  if(key&&endpoint) {
    const url=new URL(endpoint);
    if(url.protocol!=='https:'||url.username||url.password)throw new Error('Updater endpoint must use HTTPS without credentials');
    const compact=key.replace(/\s/g,'');
    const lines=Buffer.from(compact,'base64').toString('utf8').trim().split('\n');
    const raw=Buffer.from(lines[1]||'','base64');
    if(!/^[A-Za-z0-9+/]+=*$/.test(compact)||!lines[0]?.startsWith('untrusted comment:')||raw.length!==42||raw.subarray(0,2).toString()!=='Ed')throw new Error('Invalid Tauri updater public key');
    config.bundle={createUpdaterArtifacts:true,...(platform==='linux'?{targets:['deb','appimage']}:{})};
    config.plugins={updater:{pubkey:compact,endpoints:[endpoint],...(platform==='win32'?{windows:{installMode:'passive'}}:{})}};
  }
  if(platform==='win32'&&env.TUD_WINDOWS_CERTIFICATE_THUMBPRINT) {
    const thumb=env.TUD_WINDOWS_CERTIFICATE_THUMBPRINT.replace(/\s/g,'');
    if(!/^[a-fA-F0-9]{40}$/.test(thumb))throw new Error('Invalid Windows certificate thumbprint');
    const timestamp=new URL(env.TUD_WINDOWS_TIMESTAMP_URL||'');
    if(timestamp.protocol!=='https:')throw new Error('Configure an HTTPS TUD_WINDOWS_TIMESTAMP_URL');
    config.bundle={...config.bundle,windows:{certificateThumbprint:thumb,timestampUrl:timestamp.href,tsp:true,digestAlgorithm:'sha256'}};
  }
  return config;
}
export function writeReleaseConfig(env=process.env) {
  const config=releaseConfig(env);
  if(config.plugins?.updater&&!env.TAURI_SIGNING_PRIVATE_KEY)throw new Error('TAURI_SIGNING_PRIVATE_KEY is required to generate updater artifacts');
  const path=fileURLToPath(new URL('../src-tauri/tauri.release.generated.json',import.meta.url));
  writeFileSync(path,JSON.stringify(config,null,2)+'\n');
  console.log(`Prepared release config (updater ${config.plugins?.updater?'enabled':'disabled'})`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))writeReleaseConfig();

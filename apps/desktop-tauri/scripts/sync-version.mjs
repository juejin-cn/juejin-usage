import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function syncVersion(app, check = false) {
  const version = JSON.parse(readFileSync(join(app,'package.json'),'utf8')).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid desktop-tauri version');
  const config=join(app,'src-tauri/tauri.conf.json');
  const conf=JSON.parse(readFileSync(config,'utf8'));conf.version=version;
  const cargo=join(app,'src-tauri/Cargo.toml'),lock=join(app,'src-tauri/Cargo.lock');
  const manifest=readFileSync(cargo,'utf8').replace(/(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/,`$1${version}$2`);
  const locked=readFileSync(lock,'utf8').replace(/(\[\[package\]\]\nname = "jusage-desktop-tauri"\nversion = ")[^"]+("\n)/,`$1${version}$2`);
  for(const [path,body] of [[config,JSON.stringify(conf,null,2)+'\n'],[cargo,manifest],[lock,locked]]) {
    if(readFileSync(path,'utf8')!==body){if(check)throw new Error(`Version out of sync: ${path}`);writeFileSync(path,body);}
  }
  return version;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))syncVersion(fileURLToPath(new URL('..',import.meta.url)),process.argv.includes('--check'));

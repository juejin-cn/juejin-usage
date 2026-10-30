import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const PLATFORMS={
  'aarch64-apple-darwin':{key:'darwin-aarch64',suffix:'.app.tar.gz'},
  'x86_64-apple-darwin':{key:'darwin-x86_64',suffix:'.app.tar.gz'},
  'x86_64-pc-windows-msvc':{key:'windows-x86_64',suffix:'-setup.exe'},
  'x86_64-unknown-linux-gnu':{key:'linux-x86_64',suffix:'.AppImage'},
};
export function updateManifest(root,baseUrl,version) {
  const url=new URL(baseUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Provide an HTTPS release asset base URL');
  const platforms={};
  function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);if(entry.isDirectory()){walk(path);continue;}
    if(entry.name!=='artifacts.json')continue;
    const meta=JSON.parse(readFileSync(path,'utf8')),target=PLATFORMS[meta.target];
    if(!target||meta.version!==version||meta.profile!=='release')throw new Error('Mixed/unsupported candidate version, profile or target');
    if(platforms[target.key])throw new Error('Duplicate updater target');
    for(const file of meta.files){
      if(basename(file.filename)!==file.filename||/[\\/]/.test(file.filename))throw new Error('Invalid artifact name');
      const hash=createHash('sha256').update(readFileSync(join(dir,file.filename))).digest('hex');
      if(hash!==file.sha256)throw new Error(`Artifact checksum mismatch: ${file.filename}`);
    }
    const archive=meta.files.filter(f=>f.filename.endsWith(target.suffix));
    if(archive.length!==1)throw new Error(`Missing updater package for ${meta.target}`);
    const name=archive[0].filename;
    if(!meta.files.some(f=>f.filename===`${name}.sig`))throw new Error(`Missing updater signature for ${meta.target}`);
    const signature=readFileSync(join(dir,`${name}.sig`),'utf8').trim();
    if(!signature)throw new Error('Empty updater signature');
    platforms[target.key]={signature,url:`${baseUrl.replace(/\/$/,'')}/${encodeURIComponent(name)}`};
  }}walk(root);
  if(Object.keys(platforms).length!==Object.keys(PLATFORMS).length)throw new Error('All four signed native targets are required');
  return {version,pub_date:new Date().toISOString(),platforms};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,baseUrl,version]=process.argv.slice(2);
  if(!root||!baseUrl||!version)throw new Error('Usage: update-manifest.mjs <artifact-directory> <HTTPS-release-base-URL> <version>');
  const manifest=updateManifest(root,baseUrl,version);
  writeFileSync(join(root,'latest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log('Prepared latest.json from four signed release candidates; nothing was published');
}

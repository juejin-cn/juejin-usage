import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { nodeSource, sha256 } from './node-runtime.mjs';
const app=fileURLToPath(new URL('..',import.meta.url));
const out=resolve(process.env.TUD_NODE_BUILD_DIR || join(app,'.node-build'));
if (!['darwin','linux'].includes(process.platform)) throw new Error('small-icu build currently supports native macOS/Linux only; Windows retains official Node');
if (readFileSync(join(app,'.node-version'),'utf8').trim()!==nodeSource.nodeVersion) throw new Error('Update pinned source checksum for the new .node-version');
mkdirSync(out,{recursive:true});
const archive=join(out,nodeSource.archive);
if(!existsSync(archive))execFileSync('curl',['-fLsS','--retry','2','--max-time','300',nodeSource.url,'-o',archive],{stdio:'inherit'});
if(sha256(archive)!==nodeSource.sha256)throw new Error('Node source SHA-256 mismatch; remove the invalid archive before retrying');
const source=join(out,`node-v${nodeSource.nodeVersion}`);
if(!existsSync(source))execFileSync('tar',['-xzf',archive,'-C',out],{stdio:'inherit'});
const configureArgs=['--with-intl=small-icu'];
const candidates=process.env.TUD_NODE_BUILD_PYTHON ? [process.env.TUD_NODE_BUILD_PYTHON] : ['python3.13','python3.12','python3.11','python3.10','python3.9','python3.8','python3'];
const python=candidates.find(candidate=>{
  try { const [major,minor]=JSON.parse(execFileSync(candidate,['-c','import sys,json;print(json.dumps(list(sys.version_info[:2])))'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));return major===3 && minor>=8 && minor<=13; }
  catch { return false; }
});
if(!python)throw new Error('Node 22.15.0 requires Python 3.8–3.13; set TUD_NODE_BUILD_PYTHON');
execFileSync(python,['configure',...configureArgs],{cwd:source,stdio:'inherit'});
const jobs=Number(process.env.TUD_NODE_BUILD_JOBS || Math.min(8,availableParallelism()));
if(!Number.isInteger(jobs)||jobs<1||jobs>64)throw new Error('TUD_NODE_BUILD_JOBS must be between 1 and 64');
execFileSync('make',[`-j${jobs}`],{cwd:source,stdio:'inherit',env:{...process.env,PYTHON:python}});
const binary=join(source,'out/Release/node');
const actual=JSON.parse(execFileSync(binary,['-p','JSON.stringify({version:process.versions.node,small:process.config.variables.icu_small,arch:process.arch,platform:process.platform})'],{encoding:'utf8'}));
if(actual.version!==nodeSource.nodeVersion || !actual.small || actual.arch!==process.arch || actual.platform!==process.platform)throw new Error('Built Node does not match the requested runtime');
copyFileSync(join(source,'LICENSE'),join(out,'NODE-LICENSE'));
writeFileSync(join(out,'build.json'),JSON.stringify({schemaVersion:1,nodeVersion:actual.version,platform:actual.platform,arch:actual.arch,sourceUrl:nodeSource.url,sourceSha256:nodeSource.sha256,configureArgs,binary,binarySha256:sha256(binary)},null,2)+'\n');
console.log(`small-icu runtime: ${binary}\nBuild manifest: ${join(out,'build.json')}\nLicense: ${join(out,'NODE-LICENSE')}`);

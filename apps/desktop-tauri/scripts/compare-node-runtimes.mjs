import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../..',import.meta.url));
const [full,small,output]=process.argv.slice(2);
if(!full||!small||!output)throw new Error('Usage: compare-node-runtimes.mjs FULL_NODE SMALL_NODE OUTPUT_DIR (build Core/host and test:compile first)');
const out=resolve(output);mkdirSync(out,{recursive:true});
const identity=mkdtempSync(join(tmpdir(),'jusage-runtime-identity-'));
const env={...process.env,JUSAGE_CONFIG_HOME:identity,NODE_OPTIONS:'',NODE_ICU_DATA:'',TZ:'UTC',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'};
const version=readFileSync(new URL('../.node-version',import.meta.url),'utf8').trim();
const result={platform:process.platform,arch:process.arch,nodeVersion:version,runtimes:{}};
let failed=false;
try {
for(const [label,path] of [['full',full],['small',small]]) {
  const binary=resolve(path);
  const probe=spawnSync(binary,['-p','JSON.stringify({node:process.versions.node,small:process.config.variables.icu_small,arch:process.arch,platform:process.platform})'],{env,encoding:'utf8'});
  if(probe.error||probe.status!==0)throw new Error(`Cannot execute ${label} Node: ${probe.stderr}`);
  const runtime=JSON.parse(probe.stdout);
  if(runtime.node!==version||runtime.arch!==process.arch||runtime.platform!==process.platform||Boolean(runtime.small)!==(label==='small'))throw new Error(`Invalid ${label} runtime: ${probe.stdout}`);
  const record={runtime,checks:{}};result.runtimes[label]=record;
  for(const [name,dir,extension] of [['core','packages/core/dist-test/test','.test.js'],['tauri','apps/desktop-tauri/test','.test.mjs']]) {
    const files=readdirSync(join(root,dir)).filter(name=>name.endsWith(extension)).sort().map(name=>join(root,dir,name));
    if(!files.length)throw new Error(`No compiled ${name} tests`);
    const test=spawnSync(binary,['--test','--test-concurrency=1',...files],{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024});
    writeFileSync(join(out,`${label}-${name}.log`),(test.stdout||'')+(test.stderr||''));
    record.checks[name]={passed:test.status===0,exitCode:test.status,summary:(test.stdout||'').split('\n').filter(line=>/^# (tests|pass|fail|skipped) /.test(line))};
    if(test.error||test.status!==0)failed=true;
  }
}
} finally { rmSync(identity,{recursive:true,force:true}); }
writeFileSync(join(out,'report.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(failed)process.exitCode=1;

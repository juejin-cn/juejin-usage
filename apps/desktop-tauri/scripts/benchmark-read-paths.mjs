// Component benchmark: Node HTTP vs Rust file read + aggregate. This excludes
// WebView/IPC and snapshot publication, so it is not a desktop memory/speed claim.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const app=fileURLToPath(new URL('..',import.meta.url));
const samples=Number(process.env.TUD_BENCH_SAMPLES || 1000);
if(!Number.isInteger(samples)||samples<10||samples>100000)throw new Error('TUD_BENCH_SAMPLES must be 10–100000');
const binary=resolve(process.argv[2] || join(app,`src-tauri/target/read-validation/debug/read-daily${process.platform==='win32'?'.exe':''}`));
const fixture=fileURLToPath(new URL('./golden/fixture.json',import.meta.url));
const env={...process.env,NODE_OPTIONS:'',NODE_ICU_DATA:'',TZ:'UTC',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'};
const capture=JSON.parse(execFileSync(process.execPath,[join(app,'scripts/golden/worker.mjs'),fixture],{cwd:app,env,encoding:'utf8',maxBuffer:32*1024*1024}));
const record=capture.native.find(row=>row.scenario==='mixed' && row.path.endsWith('?days=7'));
const temp=mkdtempSync(join(tmpdir(),'jusage-benchmark-'));
function timed(command,args,input) {
  const mac=process.platform==='darwin';
  const result=spawnSync(mac?'/usr/bin/time':command,mac?['-l',command,...args]:args,{cwd:app,env,input,encoding:'utf8',maxBuffer:8*1024*1024});
  if(result.error || result.status!==0)throw new Error(result.stderr || String(result.error));
  return {latency:JSON.parse(result.stdout),processStatistics:result.stderr.trim()};
}
try {
  const snapshot=join(temp,'read.json');writeFileSync(snapshot,JSON.stringify(record.snapshot),{mode:0o600});
  const result={
    scope:'Synthetic frozen component benchmark; excludes Tauri/WebView/IPC and Node snapshot publication. Process statistics include startup. Never treat the two standalone RSS values as whole-app memory savings.',
    platform:process.platform,arch:process.arch,nodeVersion:process.versions.node,build:binary.includes('/release/')?'release':'debug',
    node:timed(process.execPath,[join(app,'scripts/golden/bench-worker.mjs'),String(samples)]),
    rust:timed(binary,['--benchmark',snapshot,String(samples)],JSON.stringify(record)),
  };
  if(process.argv[3])writeFileSync(resolve(process.argv[3]),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {rmSync(temp,{recursive:true,force:true});}

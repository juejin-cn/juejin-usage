import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixture=JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8'));
const clock=Date.parse(fixture.now), RealDate=Date;
globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
const localFetch=globalThis.fetch;
globalThis.fetch=()=>{throw new Error('Benchmark attempted public network access')};
const dir=await mkdtemp(join(tmpdir(),'jusage-bench-core-'));
process.env.JUSAGE_CONFIG_HOME=join(dir,'identity');
let server;
try {
  const core=await import('@juejin-opensource/jusage-core');
  const {config}=await core.loadConfig(dir);
  config.statsSince=fixture.statsSince;config.localCollectSince=fixture.statsSince;
  config.juejin.enabled=false;config.juejin.token=null;
  core.applyRemotePricingOverlay(fixture.pricing);
  const store=new core.BucketStore();store.apply(fixture.rows);
  const cache=new core.AggregateCache(dir);await cache.rebuildFromRows(fixture.rows);
  const app=core.createLocalApiApp({dataDir:dir,getConfig:()=>config,bucketStore:store,aggregateCache:cache});
  server=core.createHttpServer({honoApp:app,host:'127.0.0.1',port:0});
  const {port}=await core.listenServer(server,'127.0.0.1',0);
  const url=`http://127.0.0.1:${port}/functions/tud-usage-daily?days=7`;
  const samples=Number(process.argv[2]);const timings=[];
  for(let i=0;i<20+samples;i++) {
    const start=performance.now();
    const response=await localFetch(url);if(!response.ok)throw new Error('Node benchmark request failed');await response.json();
    if(i>=20)timings.push(performance.now()-start);
  }
  timings.sort((a,b)=>a-b);
  process.stdout.write(JSON.stringify({samples,medianMs:timings[Math.floor(samples/2)],p95Ms:timings[Math.floor(samples*0.95)]}));
} finally { if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true}); }

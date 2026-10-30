import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadSnapshotPublisher } from '../dist/host/read-snapshot.js';

test('snapshot publication is atomic and excludes overlapping mutations', async t => {
  const dir=mkdtempSync(join(tmpdir(),'tud-read-snapshot-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'read.json');let value=1;
  const publisher=new ReadSnapshotPublisher(path,()=>({value}));
  publisher.publish();assert.equal(JSON.parse(readFileSync(path,'utf8')).value,1);
  let finish;
  const first=publisher.update(async()=>{value=2;await new Promise(resolve=>{finish=resolve});});
  await publisher.update(async()=>{value=3;});
  publisher.publish();assert.equal(existsSync(path),false);
  finish();await first;
  assert.equal(JSON.parse(readFileSync(path,'utf8')).value,3);
  assert.deepEqual(readdirSync(dir),['read.json']);
  await assert.rejects(publisher.update(async()=>{value=4;throw new Error('failed rebuild')}));
  publisher.publish();assert.equal(existsSync(path),false);
  await publisher.update(async()=>{value=5;});
  assert.equal(JSON.parse(readFileSync(path,'utf8')).value,5);
});
test('shutdown cannot republish a snapshot from an in-flight update', async t => {
  const dir=mkdtempSync(join(tmpdir(),'tud-read-close-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'read.json');
  const publisher=new ReadSnapshotPublisher(path,()=>({value:1}));
  let finish;const update=publisher.update(()=>new Promise(resolve=>{finish=resolve}));
  publisher.close();finish();await update;
  publisher.publish();assert.equal(existsSync(path),false);
});

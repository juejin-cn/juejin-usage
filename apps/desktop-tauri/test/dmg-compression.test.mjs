import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { compressionArgs, dmgEnvironment } from '../scripts/dmg-compression.mjs';

test('only converts the target DMG; preserves arguments and leaves other disk operations alone',t=>{
  const root=mkdtempSync(join(tmpdir(),'jusage-dmg-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const target=join(root,'with spaces');mkdirSync(target);
  const args=['convert','source.dmg','-quiet','-format','UDZO','-imagekey','zlib-level=9','-o',join(target,'Client Beta.dmg')];
  assert.deepEqual(compressionArgs(args,target),['convert','source.dmg','-quiet','-format','ULMO','-o',join(target,'Client Beta.dmg')]);
  assert.equal(compressionArgs(args,root),args);
  for(const unchanged of [['attach','source.dmg'],['convert','a.dmg','-format','UDRW','-o',join(target,'b.dmg')],['convert','a.dmg','-format','ULMO','-o',join(target,'b.dmg')]])assert.equal(compressionArgs(unchanged,target),unchanged);
  assert.equal(compressionArgs(args,undefined),args);
});

test('adapter environment is child-scoped, cleans up, and is absent on other platforms/debug',()=>{
  const input={PATH:'/usr/bin'};
  const skipped=dmgEnvironment(input,'unused',false);assert.equal(skipped.env,input);skipped.cleanup();
  const adapter=dmgEnvironment(input,'/output',true);
  const executable=join(adapter.env.PATH.split(delimiter)[0],'hdiutil');
  try {
    assert.equal(input.PATH,'/usr/bin');assert.equal(adapter.env.TUD_DMG_OUTPUT_DIR,'/output');
    assert.match(readFileSync(executable,'utf8'),/"\$@"/);
  }finally{adapter.cleanup();}
  assert.equal(existsSync(executable),false);
});

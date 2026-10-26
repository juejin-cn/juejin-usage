import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { stagePet } from '../scripts/stage-pet.mjs';
import { petFeedback, todayReading } from '../src/pet/pet-model.mjs';

test('pet feedback excludes first load, runtime restart, rollback and midnight rollover', () => {
  const before={day:'2026-10-26',tokens:100},after={day:'2026-10-26',tokens:150};
  assert.match(petFeedback(before,after),/50/);
  assert.equal(petFeedback(null,after),null);
  assert.equal(petFeedback(before,after,false),null);
  assert.equal(petFeedback(after,before),null);
  assert.equal(petFeedback(before,{day:'2026-10-27',tokens:200}),null);
  assert.equal(todayReading({success:false,data:{todayTokens:20}}),null);
  assert.equal(todayReading({success:true,data:{todayTokens:NaN}}),null);
});

test('pet staging reuses existing sprite math and copies every builtin atlas', async t => {
  const out=mkdtempSync(join(tmpdir(),'jusage-pet-'));
  t.after(()=>rmSync(out,{recursive:true,force:true}));
  stagePet(out);
  const sprite=await import(pathToFileURL(join(out,'desktop-pet-sprite.js')).href);
  const cell=sprite.petSpriteCell('click','running-left',3);
  assert.equal(cell.mirrorX,true); assert.equal(cell.row,1);
  for(const id of ['hawking','yoyo','click'])assert.ok(existsSync(join(out,'pets',`${id}.webp`)));
  assert.match(readFileSync(join(out,'pet.html'),'utf8'),/pet.js/);
});

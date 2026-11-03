import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { stagePet } from '../scripts/stage-pet.mjs';
import { opaqueAt } from '../src/pet/pet-model.mjs';

test('pet staging reuses existing sprite math and copies every builtin atlas', async t => {
  const out=mkdtempSync(join(tmpdir(),'jusage-pet-'));
  t.after(()=>rmSync(out,{recursive:true,force:true}));
  stagePet(out);
  const sprite=await import(pathToFileURL(join(out,'desktop-pet-sprite.js')).href);
  const cell=sprite.petSpriteCell('click','running-left',3);
  assert.equal(cell.mirrorX,true); assert.equal(cell.row,1);
  for(const id of ['hawking','yoyo','click'])assert.ok(existsSync(join(out,'pets',`${id}.webp`)));
  assert.match(readFileSync(join(out,'pet.html'),'utf8'),/pet.js/);
  assert.equal(readFileSync(join(out,'desktop-pet.css'),'utf8'),readFileSync(new URL('../../desktop/src/renderer/pet.css',import.meta.url),'utf8'));
  assert.ok(existsSync(join(out,'dashboard-range.js')));
  const {formatCompactTokenCount} = await import(pathToFileURL(join(out,'pet-format.js')).href);
  assert.equal(formatCompactTokenCount(12800), '12.8K');
  assert.equal(formatCompactTokenCount(999950), '1M');
  const {buildPetSyncFeedback} = await import(pathToFileURL(join(out,'pet-sync-feedback.js')).href);
  const previous={totalTokens:100,dailyRows:[{date:'2026-11-02',tokens:100}]};
  const current={totalTokens:150,dailyRows:[{date:'2026-11-02',tokens:150}]};
  assert.equal(buildPetSyncFeedback(previous,current,'2026-11-03').addedTokens,50);

});

test('transparent hit testing respects scale, atlas frame, mirroring and outside bounds', () => {
  const pixels={width:1536,data:new Uint8Array(1536*208*4)};
  pixels.data[(192+191)*4+3]=255;
  const layout={spriteLeft:32,spriteTop:116,spriteWidth:96,spriteHeight:104};
  assert.equal(opaqueAt(pixels,{sourceX:192,sourceY:0,mirrorX:true},layout,32,116),true);
  assert.equal(opaqueAt(pixels,{sourceX:192,sourceY:0,mirrorX:false},layout,32,116),false);
  assert.equal(opaqueAt(pixels,{sourceX:192,sourceY:0,mirrorX:true},layout,31,116),false);
  assert.equal(opaqueAt(pixels,{sourceX:192,sourceY:0,mirrorX:true},layout,128,116),false);
});

test('shared motion retains the Electron curve baseline and running speed', async () => {
  const out=mkdtempSync(join(tmpdir(),'jusage-motion-'));
  try {
    stagePet(out);
    const motion=await import(pathToFileURL(join(out,'desktop-pet-motion.js')));
    const random=Math.random;
    let segments;
    try {
      Math.random=()=>0.75;
      segments=motion.createAutoMoveSegments({x:100,y:200},{x:700,y:500});
    } finally { Math.random=random; }
    // Frozen from the original Electron implementation before extracting the helper.
    const expected=[{x:236.28146254388378,y:336.1870749122324},{x:509.2814625438838,y:472.6870749122324}];
    for(let i=0;i<2;i++) {
      const point=motion.cubicPoint(segments[i],0.5);
      assert.ok(Math.abs(point.x-expected[i].x)<1e-9);
      assert.ok(Math.abs(point.y-expected[i].y)<1e-9);
    }
    assert.deepEqual(motion.cubicPoint(segments[0],0),{x:100,y:200});
    assert.deepEqual(motion.cubicPoint(segments[1],1),{x:700,y:500});
    assert.equal(motion.petFrameInterval('idle',180),180);
    assert.equal(motion.petFrameInterval('running-left',180),99);
    assert.equal(motion.petFrameInterval('running-right',120),66);
    assert.equal(motion.chooseAutoMoveTarget({x:-1920,y:0,width:150,height:100},{width:160,height:220},{x:-1900,y:0}),null);
  } finally {rmSync(out,{recursive:true,force:true});}
});

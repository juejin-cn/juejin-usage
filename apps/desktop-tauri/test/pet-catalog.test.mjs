import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import ts from 'typescript';
import { createPetHandler } from '../dist/host/pets.js';

test('native pet routes require host authentication and reuse Electron package validation', async t => {
  const root=mkdtempSync(join(tmpdir(),'jusage-native-pets-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const resources=join(root,'resources');mkdirSync(resources);writeFileSync(join(root,'package.json'),'{"type":"module"}');
  for(const name of ['desktop-pet-scanner','desktop-pet-remote']){
    const source=readFileSync(new URL(`../../desktop/src/main/${name}.ts`,import.meta.url),'utf8');
    writeFileSync(join(resources,`${name}.js`),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  }
  const remote=await import(pathToFileURL(join(resources,'desktop-pet-remote.js')).href);
  assert.equal(remote.__testing.petRawUrl('github','sample','pet.json'),'https://raw.githubusercontent.com/juejin-cn/juejin-usage/main/pets/sample/pet.json');
  const directory=join(root,'pets'), pet=join(directory,'sample');mkdirSync(pet,{recursive:true});
  writeFileSync(join(pet,'pet.json'),JSON.stringify({id:'sample',displayName:'Sample',spriteVersionNumber:2,spritesheetPath:'spritesheet.webp'}));
  cpSync(new URL('../../desktop/src/renderer/assets/pets/hawking/hawking-spritesheet.webp',import.meta.url),join(pet,'spritesheet.webp'));
  const handler=createPetHandler(directory,'native-only',resources);
  const server=createServer((req,res)=>{void handler(req,res).then(handled=>{if(!handled){res.statusCode=404;res.end();}});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}/functions/tud-desktop-pets`;
  assert.equal((await fetch(origin)).status,403);
  const options={headers:{'x-tud-host-key':'native-only'}};
  const catalog=await (await fetch(origin,options)).json();
  assert.equal(catalog.data.pets.length,4);assert.ok(catalog.data.pets.some(p=>p.id==='sample'));
  const sprite=await (await fetch(`${origin}/sprite?id=sample`,options)).json();assert.match(sprite.data.dataUrl,/^data:image\/webp;base64,/);
  assert.equal((await fetch(`${origin}/sprite?id=..%2Fsample`,options)).status,404);
  const install=await fetch(`${origin}/install`,{...options,method:'POST',body:JSON.stringify({id:'../escape'})});assert.equal(install.status,500);
  writeFileSync(join(pet,'pet.json'),'{}');
  const rejected=await (await fetch(origin,options)).json();assert.equal(rejected.data.pets.length,3);assert.equal(rejected.data.invalidPets.length,1);
});

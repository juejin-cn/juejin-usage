import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

async function fixture(overrides = {}, lineEnding = '\n') {
  const calls = [], listeners = new Map(), timers = new Map();
  let timer = 0;
  function element() {
    const events = new Map();
    return { style: {}, hidden: true, events, captured: false, removeAttribute(name){delete this[name];}, getBoundingClientRect:()=>({left:12,right:148,top:30,bottom:108}),
      addEventListener: (name, fn) => events.set(name, fn),
      setPointerCapture() { this.captured = true; },
      hasPointerCapture() { return this.captured; },
      releasePointerCapture() { this.captured = false; events.get('lostpointercapture')?.(); },
    };
  }
  const sprite = element(), bubble = element(), window = element();
  const elements={sprite,bubble,stage:element(),summary:element(),message:element(),range:element(),tokens:element(),cost:element()};
  const storage={value:null,getItem(){return this.value;}};
  const prefs = { enabled:true, selectedPetId:'hawking', scale:0.5, frameIntervalMs:180,
    autoMoveEnabled:true, autoMoveIntervalMinutes:1, syncFeedbackDurationSec:3 };
  window.__TAURI__ = { core: { invoke: async (name, args) => {
    calls.push({name,args});
    if(overrides[name])return overrides[name](args);
    if(name==='pet_get')return prefs;
    if(name==='runtime_status')return {phase:'starting'};
    if(name==='pet_cursor')return [50,150];
  } }, event: {listen:async (name, fn)=>{listeners.set(name, fn);return ()=>{};}} };
  const context = vm.createContext({window, document:{
    getElementById: id => elements[id],
    documentElement:{style:{}},body:{style:{}},
    createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({})})}),
  }, Image:class {async decode(){}},
  getDesktopPetLayout:()=>({hostWidth:160,hostHeight:220,spriteLeft:32,spriteTop:116,spriteWidth:96,spriteHeight:104,popoverWidth:136}),
  paintPetSpriteFrame(){},petSpriteCell(){return {};},opaqueAt:()=>true,
  petFeedback(){},todayReading(){},
  setInterval:()=>++timer, clearInterval(){},
  setTimeout:(fn,delay)=>{const id=++timer;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
  localStorage:storage,
  });
  const source=readFileSync(new URL('../src/pet/pet.js',import.meta.url),'utf8').replace(/\r?\n/g,lineEnding).replace(/^import .*;\r?\n/gm,'');
  const ranges=readFileSync(new URL('../../desktop/src/shared/dashboard-range.ts',import.meta.url),'utf8').replace(/export /g,'');
  vm.runInContext(ts.transpileModule(ranges,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  vm.runInContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  calls.length=0;
  const fire=(target,name,args={})=>target.events.get(name)?.({button:0,pointerId:1,screenX:100,screenY:100,clientX:50,clientY:150,preventDefault(){},...args});
  return {calls,listeners,timers,sprite,window,context,fire,elements,storage};
}

test('secondary pointer opens a positioned menu even without a contextmenu event, without duplicates',async()=>{
  const f=await fixture();
  f.fire(f.sprite,'pointerdown',{button:2});
  f.fire(f.sprite,'contextmenu',{button:2});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(c=>c.name==='pet_context').length,1);
  assert.equal(f.calls.find(c=>c.name==='pet_context').args.x,50);
  assert.equal(f.calls.find(c=>c.name==='pet_context').args.y,150);
});

test('cancel, capture loss and blur release a press so roaming can resume',async()=>{
  for(const event of ['pointercancel','blur','lostpointercapture']) {
    const f=await fixture();
    f.fire(f.sprite,'pointerdown');
    f.fire(event==='lostpointercapture'?f.sprite:f.window,event);
    vm.runInContext('nextMove=0; void roam();',f.context);
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(f.calls.some(c=>c.name==='pet_move'),event);
  }
});

test('drag uses screen coordinates and saves only after native move events settle',async()=>{
  const f=await fixture();
  f.fire(f.sprite,'pointerdown');
  f.fire(f.sprite,'pointermove',{screenX:110,clientX:50});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.calls.some(c=>c.name==='pet_drag'));
  assert.ok(!f.calls.some(c=>c.name==='pet_save_position'));
  f.listeners.get('desktop-pet:moved')({payload:null});
  f.listeners.get('desktop-pet:moved')({payload:null});
  const saves=[...f.timers.values()].filter(t=>t.delay===200);
  assert.equal(saves.length,1);
  saves[0].fn();
  assert.equal(f.calls.filter(c=>c.name==='pet_save_position').length,1);
});

test('keyboard menu works and reports native failures instead of swallowing them',async()=>{
  const f=await fixture({pet_context:()=>{throw Error('failed');}});
  f.fire(f.sprite,'keydown',{key:'F10',shiftKey:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.calls.some(c=>c.name==='pet_context'));
  assert.equal(f.elements.message.textContent,'菜单打开失败，请重试');
});


test('usage popover shares Electron dimensions, toggles, and refreshes on sync and range changes',async()=>{
  const f=await fixture({api_request:()=>({status:200,body:JSON.stringify({success:true,data:{days:[{tokens:1132646268,costUsd:820.29}]}})})});
  f.fire(f.sprite,'click');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.elements.bubble.style.width,'136px');
  assert.equal(f.elements.bubble.style.bottom,'112px');
  assert.equal(f.elements.range.textContent,'近 7 天');
  assert.equal(f.elements.tokens.textContent,'1.1B');
  assert.equal(f.elements.tokens.title,'1,132,646,268');
  assert.equal(f.elements.cost.textContent,'$820.29');
  f.storage.value=JSON.stringify('today');
  f.fire(f.window,'storage',{key:'tud.dashboardRange'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.elements.range.textContent,'今天');
  assert.equal(f.calls.at(-1).args.request.path,'/functions/tud-usage-daily?days=1');
  const count=f.calls.filter(c=>c.name==='api_request').length;
  f.listeners.get('tud:data-synced')({payload:null});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.calls.filter(c=>c.name==='api_request').length>count);
  f.fire(f.sprite,'click');
  assert.equal(f.elements.bubble.hidden,true);
});

test('late range responses cannot replace current totals or reopen a dismissed popover',async()=>{
  const pending=[];
  const f=await fixture({api_request:()=>new Promise(resolve=>pending.push(resolve))});
  const response=tokens=>({status:200,body:JSON.stringify({success:true,data:{days:[{tokens,costUsd:1}]}})});
  f.fire(f.sprite,'click');
  f.storage.value=JSON.stringify('today');f.fire(f.window,'storage',{key:'tud.dashboardRange'});
  pending[1](response(2000));await new Promise(resolve=>setImmediate(resolve));
  pending[0](response(9000));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.elements.tokens.textContent,'2K');
  f.fire(f.window,'storage',{key:'tud.dashboardRange'});
  f.fire(f.sprite,'click');pending[2](response(3000));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.elements.bubble.hidden,true);
  assert.equal(f.elements.tokens.textContent,'…');
});

// Git checks files out with CRLF on Windows runners.
test('pet fixture loads CRLF source on Windows',async()=>{
  const f=await fixture({},'\r\n');
  f.fire(f.sprite,'contextmenu',{button:2});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(c=>c.name==='pet_context').length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { stagePet } from '../scripts/stage-pet.mjs';
const staged = mkdtempSync(join(tmpdir(), 'jusage-pet-interaction-'));
stagePet(staged);
after(() => rmSync(staged, { recursive: true, force: true }));
const { formatCompactTokenCount } = await import(pathToFileURL(join(staged, 'pet-format.js')));
const {getDesktopPetLayout} = await import(pathToFileURL(join(staged, 'desktop-pet-layout.js')));
const {DESKTOP_PETS} = await import(pathToFileURL(join(staged, 'pet-appearance.js')));
const motion = await import(pathToFileURL(join(staged, 'desktop-pet-motion.js')));
const { isPetSyncFeedback } = await import(pathToFileURL(join(staged, 'pet-sync-feedback.js')));
import vm from 'node:vm';
import ts from 'typescript';

async function fixture(overrides = {}, lineEnding = '\n') {
  const calls = [], paints = [], numberUpdates = [], numberStates = [], listeners = new Map(), timers = new Map(), intervals = new Map();
  let timer = 0;
  function element() {
    const events = new Map();
    return { style: {setProperty(name,value){this[name]=value;}}, hidden: true, events, captured: false, setAttribute(name,value){this[name]=value;}, removeAttribute(name){delete this[name];}, getBoundingClientRect:()=>({left:12,right:148,top:30,bottom:108}),
      addEventListener: (name, fn) => events.set(name, fn),
      setPointerCapture() { this.captured = true; },
      hasPointerCapture() { return this.captured; },
      releasePointerCapture() { this.captured = false; events.get('lostpointercapture')?.(); },
    };
  }
  const sprite = element(), bubble = element(), window = element();
  window.matchMedia=()=>({matches:true});
  const elements={sprite,bubble,stage:element(),summary:element(),message:element(),range:element(),tokens:element(),cost:element(),feedback:element(),'feedback-amount':element(),milestones:element(),record:element(),streak:element()};
  const storage={value:null,getItem(){return this.value;}};
  const prefs = { enabled:true, selectedPetId:'hawking', scale:0.5, frameIntervalMs:180,
    autoMoveEnabled:true, autoMoveIntervalMinutes:1, syncFeedbackDurationSec:3, syncFeedbackEnabled:true };
  window.__TAURI__ = { core: { invoke: async (name, args) => {
    calls.push({name,args});
    if(overrides[name])return overrides[name](args);
    if(name==='pet_get')return prefs;
    if(name==='runtime_status')return {phase:'starting'};
    if(name==='pet_cursor')return [50,150];
    if(name==='pet_roam_bounds')return {current:{x:100,y:200},area:{x:0,y:0,width:1920,height:1080},size:{width:160,height:220}};
  } }, event: {listen:async (name, fn)=>{listeners.set(name, fn);return ()=>{};}} };
  const context = vm.createContext({window, document:{
    getElementById: id => elements[id],
    documentElement:{style:{}},body:{style:{}},
    createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({})})}),
  }, Image:class {async decode(){}},
  getDesktopPetLayout,DESKTOP_PETS,
  createPetNumberRenderer:(tokens,cost)=>{
    let target;
    return {
      update(next){if(target?.tokens===next.tokens&&target?.cost===next.cost)return;target=next;numberUpdates.push(next);tokens.textContent=formatCompactTokenCount(next.tokens);cost.textContent=`$${next.cost.toFixed(2)}`;},
      loading(){target=null;numberStates.push('loading');tokens.textContent='…';cost.textContent='…';},
      error(){target=null;numberStates.push('error');tokens.textContent='--';cost.textContent='--';},
      clear(){target=null;tokens.textContent='';cost.textContent='';},dispose(){},
    };
  },
  ...motion,paintPetSpriteFrame(...args){paints.push(args);},petSpriteCell(){return {};},opaqueAt:()=>true,
  isPetSyncFeedback,formatCompactTokenCount,performance:{now:()=>0},
  requestAnimationFrame:fn=>{const id=++timer;timers.set(id,{fn,delay:'frame'});return id;},cancelAnimationFrame:id=>timers.delete(id),
  setInterval:(fn,delay)=>{const id=++timer;intervals.set(id,{fn,delay});return id;}, clearInterval:id=>intervals.delete(id),
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
  return {calls,paints,numberUpdates,numberStates,listeners,timers,intervals,sprite,window,context,fire,elements,storage};
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
    assert.ok(f.calls.some(c=>c.name==='pet_move_to'),event);
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
  assert.equal(f.elements.bubble.style.width,'180px');
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
  assert.equal(f.numberUpdates.at(-1).tokens,2000);
});

// Git checks files out with CRLF on Windows runners.
test('pet fixture loads CRLF source on Windows',async()=>{
  const f=await fixture({},'\r\n');
  f.fire(f.sprite,'contextmenu',{button:2});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(c=>c.name==='pet_context').length,1);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const feedbackValue = {addedTokens:12800,isDailyRecord:true,activeStreakDays:3};
test('sync feedback replaces the open summary and renders Electron milestones and exact values',async()=>{
  const f=await fixture({api_request:()=>({status:200,body:JSON.stringify({success:true,data:{days:[{tokens:100,costUsd:1}]}})})});
  f.fire(f.sprite,'click');await flush();
  f.listeners.get('tud:data-synced')({payload:feedbackValue});await flush();
  assert.equal(f.elements.summary.hidden,true);
  assert.equal(f.elements.feedback.hidden,false);
  assert.equal(f.elements['feedback-amount'].textContent,'12.8K');
  assert.equal(f.elements['feedback-amount'].title,(12800).toLocaleString());
  assert.equal(f.elements.record.hidden,false);
  assert.equal(f.elements.streak.textContent,'🔥 连续使用 3 天');
  assert.equal(f.elements.bubble.hidden,false);
  // A late summary response must not reopen or replace the feedback.
  assert.equal(f.elements.summary.hidden,true);
});

test('consecutive syncs replace feedback, reset duration and hide absent milestones',async()=>{
  const f=await fixture();
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  const first=[...f.timers.keys()];
  f.listeners.get('tud:data-synced')({payload:{addedTokens:500,isDailyRecord:false,activeStreakDays:1}});
  assert.equal(f.elements['feedback-amount'].textContent,'500');
  assert.equal(f.elements.milestones.hidden,true);
  assert.equal(first.some(id=>f.timers.has(id)),false);
  const expiry=[...f.timers.values()].filter(t=>t.delay===3000);
  assert.equal(expiry.length,1);
  expiry[0].fn();
  assert.equal(f.elements.bubble.hidden,true);
});

test('pointer down dismisses feedback immediately and suppresses sync until release',async()=>{
  const f=await fixture();
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  f.fire(f.sprite,'pointerdown');
  assert.equal(f.elements.bubble.hidden,true);
  assert.equal([...f.timers.values()].some(t=>t.delay===3000),false);
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  assert.equal(f.elements.bubble.hidden,true);
  f.fire(f.window,'pointerup');
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  assert.equal(f.elements.feedback.hidden,false);
});

test('native dragging suppresses celebrations and feedback resumes after drag completes',async()=>{
  let finish;
  const f=await fixture({pet_drag:()=>new Promise(resolve=>{finish=resolve;})});
  f.fire(f.sprite,'pointerdown');f.fire(f.sprite,'pointermove',{screenX:110});
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  assert.equal(f.elements.bubble.hidden,true);
  finish();await flush();
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  assert.equal(f.elements.feedback.hidden,false);
});

test('preference changes keep feedback usable; disabled feedback and null events do not celebrate',async()=>{
  const f=await fixture();
  const prefs=vm.runInContext('({...prefs,scale:0.6})',f.context);
  f.listeners.get('desktop-pet:preferences')({payload:prefs});
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  assert.equal(f.elements.feedback.hidden,false);
  vm.runInContext('hideBubble()',f.context);
  f.listeners.get('tud:data-synced')({payload:null});
  assert.equal(f.elements.bubble.hidden,true);
  f.listeners.get('desktop-pet:preferences')({payload:{...prefs,syncFeedbackEnabled:false}});
  f.listeners.get('tud:data-synced')({payload:feedbackValue});
  assert.equal(f.elements.bubble.hidden,true);
});

test('summary refresh updates the shared number renderer without clearing visible values',async()=>{
  let total=1000;
  const f=await fixture({api_request:()=>({status:200,body:JSON.stringify({success:true,data:{days:[{tokens:total,costUsd:2}]}})})});
  f.fire(f.sprite,'click');await flush();
  assert.equal(f.elements.tokens.textContent,'1K');
  total=2000;
  f.listeners.get('tud:data-synced')({payload:null});await flush();
  assert.equal(f.numberStates.filter(value=>value==='loading').length,1);
  assert.equal(f.elements.tokens.textContent,'2K');
  const count=f.numberUpdates.length;
  f.listeners.get('tud:data-synced')({payload:null});await flush();
  assert.equal(f.numberUpdates.length,count);
});

test('drag animates in its actual direction at the Electron running cadence, then returns idle', async () => {
  let finish;
  const f=await fixture({pet_drag:()=>new Promise(resolve=>{finish=resolve;})});
  f.fire(f.sprite,'pointerdown');f.fire(f.sprite,'pointermove',{screenX:110});
  assert.equal(f.paints.at(-1)[2],'running-right');
  assert.ok([...f.intervals.values()].some(t=>t.delay===99));
  const clock=[...f.intervals.values()].find(t=>t.delay===99);
  const before=f.paints.at(-1)[3];clock.fn();
  assert.equal(f.paints.at(-1)[3],before+1);
  f.listeners.get('desktop-pet:moved')({payload:[200,100]});
  f.listeners.get('desktop-pet:moved')({payload:[190,100]});
  assert.equal(f.paints.at(-1)[2],'running-left');
  finish();await flush();
  [...f.timers.values()].find(t=>t.delay===200).fn();
  assert.equal(f.paints.at(-1)[2],'idle');
  assert.ok([...f.intervals.values()].some(t=>t.delay===180));
});

test('unrelated preferences preserve sprite frame, animation and movement deadline', async () => {
  const f=await fixture();
  vm.runInContext("frame=4;setAnimation('running-left');nextMove=123456;",f.context);
  const before=f.paints.length;
  const prefs=vm.runInContext('({...prefs,syncFeedbackDurationSec:5})',f.context);
  f.listeners.get('desktop-pet:preferences')({payload:prefs});await flush();
  assert.equal(f.paints.length,before);
  assert.equal(vm.runInContext('animation',f.context),'running-left');
  assert.equal(vm.runInContext('frame',f.context),4);
  assert.equal(vm.runInContext('nextMove',f.context),123456);
});

test('late roaming setup cannot move or reset a newer drag', async () => {
  let bounds,finish;
  const f=await fixture({pet_roam_bounds:()=>new Promise(resolve=>{bounds=resolve;}),pet_drag:()=>new Promise(resolve=>{finish=resolve;})});
  vm.runInContext('nextMove=0;void roam();',f.context);await flush();
  f.fire(f.sprite,'pointerdown');f.fire(f.sprite,'pointermove',{screenX:90});
  bounds({current:{x:100,y:200},area:{x:0,y:0,width:1920,height:1080},size:{width:160,height:220}});
  await flush();
  assert.equal(f.calls.some(c=>c.name==='pet_move_to'),false);
  assert.equal(vm.runInContext('animation',f.context),'running-left');
  finish();await flush();
});

test('nonblocking native drag keeps running and small reverse movements accumulate', async () => {
  const f=await fixture();
  f.fire(f.sprite,'pointerdown');f.fire(f.sprite,'pointermove',{screenX:110});await flush();
  assert.equal(vm.runInContext('animation',f.context),'running-right');
  f.listeners.get('desktop-pet:moved')({payload:[200,100]});
  f.listeners.get('desktop-pet:moved')({payload:[199,100]});
  f.listeners.get('desktop-pet:moved')({payload:[198,100]});
  assert.equal(vm.runInContext('animation',f.context),'running-left');
});

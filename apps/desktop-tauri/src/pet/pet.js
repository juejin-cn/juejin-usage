import { DASHBOARD_RANGE_DAYS, DASHBOARD_RANGE_LABELS, DEFAULT_DASHBOARD_RANGE, isDashboardRange } from './dashboard-range.js';
import { paintPetSpriteFrame, petSpriteCell } from './desktop-pet-sprite.js';
import { getDesktopPetLayout } from './desktop-pet-layout.js';
import { opaqueAt } from './pet-model.mjs';
import { isPetSyncFeedback } from './pet-sync-feedback.js';
import { formatCompactTokenCount } from './pet-format.js';
const invoke = window.__TAURI__.core.invoke;
const sprite = document.getElementById('sprite'), bubble = document.getElementById('bubble');
const stage = document.getElementById('stage'), summary = document.getElementById('summary'), message = document.getElementById('message');
const rangeLabel = document.getElementById('range'), tokens = document.getElementById('tokens'), cost = document.getElementById('cost');
const feedback = document.getElementById('feedback'), amount = document.getElementById('feedback-amount');
const milestones = document.getElementById('milestones'), record = document.getElementById('record'), streak = document.getElementById('streak');
let tooltipOpen=false, summarySequence=0, summaryValues={tokens:0,cost:0}, animationFrame=null, animationTarget=null;
function stopNumberAnimation() { if(animationFrame!==null)cancelAnimationFrame(animationFrame);animationFrame=null;animationTarget=null; }
function hideBubble() { tooltipOpen=false;summarySequence++;clearTimeout(bubbleTimer);stopNumberAnimation();bubble.hidden=true;feedback.hidden=true; }

let prefs = {enabled:false,scale:0.5,frameIntervalMs:180,autoMoveEnabled:true,autoMoveIntervalMinutes:2,syncFeedbackEnabled:false,syncFeedbackDurationSec:3};
let runtimePhase='starting', runtimeReceived=false, pet='hawking', frame=0, epoch=0, assetSequence=0, bubbleTimer, clock;
let disposed=false, press=null, dragged=false, nativeDragging=false, moving=false, animation='idle', nextMove=Infinity, cursorBusy=false, lastIgnored=false, menuOpen=false, secondaryMenu=false, positionTimer;
let layout=getDesktopPetLayout(0.5), pixels=null;
const stops=[];
function show(text) {
  if(tooltipOpen)return;
  summary.hidden=true;feedback.hidden=true;message.hidden=false;message.textContent=text;bubble.hidden=false;
  clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>{bubble.hidden=true;},prefs.syncFeedbackDurationSec*1000);
}
function showFeedback(value) {
  if(!prefs.enabled||!prefs.syncFeedbackEnabled||!isPetSyncFeedback(value)||press||nativeDragging||menuOpen)return;
  hideBubble();
  summary.hidden=true;message.hidden=true;feedback.hidden=false;
  amount.textContent=formatCompactTokenCount(value.addedTokens);
  amount.title=Math.round(value.addedTokens).toLocaleString();
  record.hidden=!value.isDailyRecord;
  streak.hidden=value.activeStreakDays<2;
  streak.textContent=`🔥 连续使用 ${value.activeStreakDays} 天`;
  milestones.hidden=record.hidden&&streak.hidden;
  bubble.hidden=false;
  bubbleTimer=setTimeout(()=>{feedback.hidden=true;bubble.hidden=true;},Math.max(1,prefs.syncFeedbackDurationSec)*1000);
}
function animateTotals(next) {
  if(animationFrame!==null&&animationTarget?.tokens===next.tokens&&animationTarget?.cost===next.cost)return;
  stopNumberAnimation();
  animationTarget=next;
  const from={...summaryValues},start=performance.now();
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function paint(now) {
    const progress=reduced?1:Math.min((now-start)/1200,1),ease=1-Math.pow(1-progress,3);
    summaryValues={tokens:from.tokens+(next.tokens-from.tokens)*ease,cost:from.cost+(next.cost-from.cost)*ease};
    tokens.textContent=formatCompactTokenCount(summaryValues.tokens);
    cost.textContent=`$${summaryValues.cost.toFixed(2)}`;
    animationFrame=progress<1?requestAnimationFrame(paint):null;
  }
  if(reduced||(from.tokens===next.tokens&&from.cost===next.cost))paint(start+1200);
  else animationFrame=requestAnimationFrame(paint);
}
async function loadSprite(id) {
  const generation=++assetSequence;
  let url=`/pets/${id}.webp`;
  try {
    if(!['hawking','yoyo','click'].includes(id)) {
      const result=await invoke('api_request',{request:{path:`/functions/tud-desktop-pets/sprite?id=${encodeURIComponent(id)}`,method:'GET',body:null}});
      const data=JSON.parse(result.body);if(!data.success)throw new Error('missing');url=data.data.dataUrl;
    }
    const image=new Image();image.src=url;await image.decode();
    if(generation!==assetSequence||disposed)return;
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);pixels=context.getImageData(0,0,image.width,image.height);
    sprite.style.backgroundImage=`url('${url}')`;
  }catch{if(generation===assetSequence){pixels=null;sprite.style.backgroundImage="url('/pets/hawking.webp')";show('宠物包不可用，请在设置中刷新');}}
}
function apply(value) {
  const changed=value.selectedPetId!==pet;
  prefs=value;epoch++;
  press=null;
  if(!prefs.enabled){hideBubble();animation='idle';}
  pet=prefs.selectedPetId;layout=getDesktopPetLayout(prefs.scale);
  document.documentElement.style.width=`${layout.hostWidth}px`;document.documentElement.style.height=`${layout.hostHeight}px`;
  document.body.style.width=`${layout.hostWidth}px`;document.body.style.height=`${layout.hostHeight}px`;
  Object.assign(stage.style,{width:`${layout.spriteWidth}px`,height:`${layout.spriteHeight}px`,left:`${layout.spriteLeft}px`,top:`${layout.spriteTop}px`});
  Object.assign(sprite.style,{width:`${layout.spriteWidth}px`,height:`${layout.spriteHeight}px`,backgroundSize:`${layout.spriteWidth*8}px ${layout.spriteHeight*11}px`});
  bubble.style.width=`${layout.popoverWidth}px`;bubble.style.bottom=`${layout.spriteHeight+8}px`;
  clearInterval(clock);clock=setInterval(tick,prefs.frameIntervalMs);nextMove=Date.now()+prefs.autoMoveIntervalMinutes*60000;
  frame=0;paintPetSpriteFrame(sprite,pet,'idle',frame,layout.spriteWidth,layout.spriteHeight);
  if(changed||!pixels)void loadSprite(pet);
  void invoke('pet_mouse_ignore',{ignored:false});lastIgnored=false;
}
function tick(){if(prefs.enabled&&!press&&!menuOpen)paintPetSpriteFrame(sprite,pet,animation,++frame,layout.spriteWidth,layout.spriteHeight);}
async function roam() {
  if(!prefs.enabled||!prefs.autoMoveEnabled||press||nativeDragging||menuOpen||moving||Date.now()<nextMove)return;
  moving=true;const generation=epoch,dx=Math.random()<0.5?-3:3;animation=dx<0?'running-left':'running-right';
  try {for(let i=0;i<60&&generation===epoch&&!press&&prefs.enabled;i++){await invoke('pet_move',{dx});await new Promise(resolve=>setTimeout(resolve,40));}}
  catch{}finally{moving=false;animation='idle';nextMove=Date.now()+prefs.autoMoveIntervalMinutes*60000;void invoke('pet_save_position').catch(()=>{});}
}
const moveTimer=setInterval(()=>{void roam();},1000);
// Poll native cursor even while the window ignores mouse input; otherwise
// entering the opaque sprite could never restore interactivity.
const hitTimer=setInterval(async()=>{
  if(!prefs.enabled||cursorBusy||press||nativeDragging||menuOpen||moving||!pixels)return;cursorBusy=true;
  try {
    const [x,y]=await invoke('pet_cursor');
    const bounds=bubble.getBoundingClientRect();
    const overBubble=!bubble.hidden&&x>=bounds.left&&x<bounds.right&&y>=bounds.top&&y<bounds.bottom;
    const opaque=overBubble||opaqueAt(pixels,petSpriteCell(pet,animation,frame),layout,x,y);
    if(press||menuOpen)return;
    if(lastIgnored===opaque){await invoke('pet_mouse_ignore',{ignored:!opaque});lastIgnored=!opaque;}
  }catch{}finally{cursorBusy=false;}
},100);
function readRange() {
  try {const value=JSON.parse(localStorage.getItem('tud.dashboardRange'));return isDashboardRange(value)?value:DEFAULT_DASHBOARD_RANGE;}
  catch{return DEFAULT_DASHBOARD_RANGE;}
}
async function showRange(reset=false) {
  if(!tooltipOpen)return;
  const request=++summarySequence, range=readRange();
  clearTimeout(bubbleTimer);summary.hidden=false;message.hidden=true;feedback.hidden=true;bubble.hidden=false;
  rangeLabel.textContent=DASHBOARD_RANGE_LABELS[range];
  if(reset){stopNumberAnimation();summaryValues={tokens:0,cost:0};tokens.textContent='…';cost.textContent='…';tokens.removeAttribute('title');tokens.removeAttribute('aria-label');}
  try {
    const result=await invoke('api_request',{request:{path:`/functions/tud-usage-daily?days=${DASHBOARD_RANGE_DAYS[range]}`,method:'GET',body:null}});
    const body=JSON.parse(result.body);if(result.status!==200||!body.success)throw new Error('unavailable');
    const totals=(body.data.days??[]).reduce((total,row)=>({tokens:total.tokens+row.tokens,cost:total.cost+row.costUsd}),{tokens:0,cost:0});
    if(!Number.isFinite(totals.tokens)||!Number.isFinite(totals.cost))throw new Error('invalid totals');
    if(disposed||!tooltipOpen||request!==summarySequence)return;
    tokens.title=Math.round(totals.tokens).toLocaleString();tokens.setAttribute('aria-label',`Token ${tokens.title}`);
    animateTotals(totals);
  }catch{if(!disposed&&tooltipOpen&&request===summarySequence){stopNumberAnimation();tokens.textContent='--';cost.textContent='--';}}
}
window.addEventListener('storage',event=>{if(event.key===null||event.key==='tud.dashboardRange')void showRange(true);});
sprite.addEventListener('click',()=>{if(dragged){dragged=false;return;}if(tooltipOpen){hideBubble();return;}tooltipOpen=true;void showRange(true);});
sprite.addEventListener('dblclick',()=>{hideBubble();void invoke('window_action',{action:'show'});});
function releasePointer() { press=null; }
async function openContextMenu(x, y) {
  if(menuOpen)return;
  hideBubble();menuOpen=true;press=null;epoch++;animation='idle';
  try {
    await invoke('pet_mouse_ignore',{ignored:false});lastIgnored=false;
    await invoke('pet_context',{x,y});
  } catch { show('菜单打开失败，请重试'); }
  finally { menuOpen=false;nextMove=Date.now()+prefs.autoMoveIntervalMinutes*60000; }
}
sprite.addEventListener('contextmenu',event=>{
  event.preventDefault();
  if(!secondaryMenu)void openContextMenu(event.clientX,event.clientY);
});
sprite.addEventListener('keydown',event=>{
  secondaryMenu=false;
  if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')) {
    event.preventDefault();
    void openContextMenu(layout.spriteLeft+layout.spriteWidth/2,layout.spriteTop+layout.spriteHeight/2);
  }
});
sprite.addEventListener('pointerdown',event=>{
  secondaryMenu=event.button===2||(event.button===0&&event.ctrlKey);
  if(secondaryMenu){event.preventDefault();void openContextMenu(event.clientX,event.clientY);return;}
  if(event.button===0){
    clearTimeout(bubbleTimer);feedback.hidden=true;if(!tooltipOpen)bubble.hidden=true;
    epoch++;animation='idle';dragged=false;
    press={x:event.screenX,y:event.screenY};
    sprite.setPointerCapture(event.pointerId);
  }
});
sprite.addEventListener('pointermove',event=>{
  if(press&&Math.hypot(event.screenX-press.x,event.screenY-press.y)>4){
    hideBubble();press=null;dragged=true;epoch++;
    if(sprite.hasPointerCapture(event.pointerId))sprite.releasePointerCapture(event.pointerId);
    nativeDragging=true;
    void invoke('pet_drag').catch(()=>show('拖动失败，请重试')).finally(()=>{nativeDragging=false;});
  }
});
window.addEventListener('pointerup',releasePointer);
window.addEventListener('pointercancel',releasePointer);
window.addEventListener('blur',releasePointer);
sprite.addEventListener('lostpointercapture',releasePointer);
async function listen(event,callback){const stop=await window.__TAURI__.event.listen(event,message=>{if(!disposed)callback(message.payload);});if(disposed)stop();else stops.push(stop);}
void listen('desktop-pet:preferences',apply);
// Native dragging consumes pointerup on some platforms. Save after actual move
// events settle, rather than after the start-dragging command is dispatched.
void listen('desktop-pet:moved',()=>{
  clearTimeout(positionTimer);
  positionTimer=setTimeout(()=>{void invoke('pet_save_position').catch(()=>{});},200);
});
void listen('tud:data-synced',value=>{void showRange();showFeedback(value);});
function applyRuntime(status){runtimePhase=status.phase;if(status.phase!=='ready'){epoch++;}else{void showRange();if(!pixels)void loadSprite(pet);}}
void listen('tud:runtime-status',status=>{runtimeReceived=true;applyRuntime(status);});
void invoke('runtime_status').then(status=>{if(!runtimeReceived)applyRuntime(status);});
void invoke('pet_get').then(apply);
window.addEventListener('unload',()=>{disposed=true;stopNumberAnimation();summarySequence++;epoch++;clearInterval(clock);clearInterval(moveTimer);clearInterval(hitTimer);clearTimeout(bubbleTimer);clearTimeout(positionTimer);stops.forEach(stop=>stop());});

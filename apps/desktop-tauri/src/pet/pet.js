import { paintPetSpriteFrame, petSpriteCell } from './desktop-pet-sprite.js';
import { getDesktopPetLayout } from './desktop-pet-layout.js';
import { petFeedback, todayReading, opaqueAt } from './pet-model.mjs';
const invoke = window.__TAURI__.core.invoke;
const sprite = document.getElementById('sprite'), bubble = document.getElementById('bubble');
let prefs = {enabled:false,scale:0.5,frameIntervalMs:180,autoMoveEnabled:true,autoMoveIntervalMinutes:2,syncFeedbackEnabled:false,syncFeedbackDurationSec:3};
let runtimePhase='starting', runtimeReceived=false, pet='hawking', frame=0, previous=null, epoch=0, sequence=0, assetSequence=0, bubbleTimer, clock;
let disposed=false, press=null, dragged=false, moving=false, animation='idle', nextMove=Infinity, cursorBusy=false, lastIgnored=false;
let layout=getDesktopPetLayout(0.5), pixels=null;
const stops=[];
function show(text) {bubble.textContent=text;bubble.hidden=false;clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>{bubble.hidden=true;},prefs.syncFeedbackDurationSec*1000);}
async function refresh(celebrate=false) {
  if(!prefs.enabled)return;
  const request=++sequence,runtime=epoch;
  try {
    const response=await invoke('api_request',{request:{path:'/functions/tud-account-usage-summary',method:'GET',body:null}});
    if(request!==sequence||runtime!==epoch||response.status!==200)return;
    const current=todayReading(JSON.parse(response.body));if(!current)return;
    const message=petFeedback(previous,current);previous=current;
    if(celebrate&&prefs.syncFeedbackEnabled&&message)show(message);return current;
  }catch{if(request===sequence){previous=null;if(runtimePhase==='failed')show('本地服务已停止');}}
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
  prefs=value;epoch++;previous=null;
  if(!prefs.enabled){bubble.hidden=true;moving=false;animation='idle';}
  pet=prefs.selectedPetId;layout=getDesktopPetLayout(prefs.scale);
  document.documentElement.style.width=`${layout.hostWidth}px`;document.documentElement.style.height=`${layout.hostHeight}px`;
  document.body.style.width=`${layout.hostWidth}px`;document.body.style.height=`${layout.hostHeight}px`;
  Object.assign(sprite.style,{width:`${layout.spriteWidth}px`,height:`${layout.spriteHeight}px`,left:`${layout.spriteLeft}px`,top:`${layout.spriteTop}px`,backgroundSize:`${layout.spriteWidth*8}px ${layout.spriteHeight*11}px`});
  bubble.style.left=`${(layout.hostWidth-148)/2}px`;bubble.style.top=`${layout.spriteTop-106}px`;
  clearInterval(clock);clock=setInterval(tick,prefs.frameIntervalMs);nextMove=Date.now()+prefs.autoMoveIntervalMinutes*60000;
  frame=0;paintPetSpriteFrame(sprite,pet,'idle',frame,layout.spriteWidth,layout.spriteHeight);
  if(changed||!pixels)void loadSprite(pet);
  void invoke('pet_mouse_ignore',{ignored:false});lastIgnored=false;
}
function tick(){if(prefs.enabled)paintPetSpriteFrame(sprite,pet,animation,++frame,layout.spriteWidth,layout.spriteHeight);}
async function roam() {
  if(!prefs.enabled||!prefs.autoMoveEnabled||press||moving||Date.now()<nextMove)return;
  moving=true;const generation=epoch,dx=Math.random()<0.5?-3:3;animation=dx<0?'running-left':'running-right';
  try {for(let i=0;i<60&&generation===epoch&&!press&&prefs.enabled;i++){await invoke('pet_move',{dx});await new Promise(resolve=>setTimeout(resolve,40));}}
  catch{}finally{moving=false;animation='idle';nextMove=Date.now()+prefs.autoMoveIntervalMinutes*60000;void invoke('pet_save_position').catch(()=>{});}
}
const moveTimer=setInterval(()=>{void roam();},1000);
// Poll native cursor even while the window ignores mouse input; otherwise
// entering the opaque sprite could never restore interactivity.
const hitTimer=setInterval(async()=>{
  if(!prefs.enabled||cursorBusy||press||moving||!pixels)return;cursorBusy=true;
  try {
    const [x,y]=await invoke('pet_cursor');
    const opaque=opaqueAt(pixels,petSpriteCell(pet,animation,frame),layout,x,y);
    if(lastIgnored===opaque){lastIgnored=!opaque;await invoke('pet_mouse_ignore',{ignored:lastIgnored});}
  }catch{}finally{cursorBusy=false;}
},100);
async function showRange() {
  try {
    let range;try{range=JSON.parse(localStorage.getItem('tud.dashboardRange')??'"last-7-days"');}catch{range='last-7-days';}
    const ranges={today:[1,'今天'],'last-7-days':[7,'近 7 天'],'last-30-days':[30,'近 30 天'],'last-90-days':[90,'近 90 天']};
    const [days,label]=ranges[range]??ranges['last-7-days'];
    const result=await invoke('api_request',{request:{path:`/functions/tud-usage-daily?days=${days}`,method:'GET',body:null}});
    const body=JSON.parse(result.body);if(!body.success)throw new Error('unavailable');
    const totals=(body.data.days??[]).reduce((total,row)=>({tokens:total.tokens+row.tokens,cost:total.cost+row.costUsd}),{tokens:0,cost:0});
    show(`${label}\n${Math.round(totals.tokens).toLocaleString()} Token · $${totals.cost.toFixed(2)}`);
  }catch{show('用量暂不可用');}
}
sprite.addEventListener('click',()=>{if(dragged){dragged=false;return;}void showRange();});
sprite.addEventListener('dblclick',()=>{void invoke('window_action',{action:'show'});});
sprite.addEventListener('contextmenu',event=>{event.preventDefault();void invoke('pet_context').catch(()=>{});});
sprite.addEventListener('pointerdown',event=>{if(event.button===0){dragged=false;press={x:event.clientX,y:event.clientY};}});
sprite.addEventListener('pointermove',event=>{if(press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>4){press=null;dragged=true;moving=false;epoch++;void invoke('pet_drag').then(()=>invoke('pet_save_position')).catch(()=>{});}});
window.addEventListener('pointerup',()=>{press=null;});
async function listen(event,callback){const stop=await window.__TAURI__.event.listen(event,message=>{if(!disposed)callback(message.payload);});if(disposed)stop();else stops.push(stop);}
void listen('desktop-pet:preferences',apply);
void listen('tud:data-synced',()=>{void refresh(true);});
function applyRuntime(status){runtimePhase=status.phase;if(status.phase!=='ready'){epoch++;previous=null;}else{void refresh();if(!pixels)void loadSprite(pet);}}
void listen('tud:runtime-status',status=>{runtimeReceived=true;applyRuntime(status);});
void invoke('runtime_status').then(status=>{if(!runtimeReceived)applyRuntime(status);});
void invoke('pet_get').then(apply);
window.addEventListener('unload',()=>{disposed=true;epoch++;clearInterval(clock);clearInterval(moveTimer);clearInterval(hitTimer);clearTimeout(bubbleTimer);stops.forEach(stop=>stop());});

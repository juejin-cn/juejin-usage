import { paintPetSpriteFrame } from './desktop-pet-sprite.js';
import { petFeedback, todayReading } from './pet-model.mjs';
const invoke = window.__TAURI__.core.invoke;
const sprite = document.getElementById('sprite');
const bubble = document.getElementById('bubble');
let runtimePhase = 'starting', runtimeReceived = false;
let enabled = true, pet = 'hawking', frame = 0, previous = null, epoch = 0, sequence = 0, bubbleTimer;
const stops = [];
function show(text) {
  bubble.textContent = text; bubble.hidden = false;
  clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 3500);
}
async function refresh(celebrate = false) {
  if (!enabled) return;
  const request = ++sequence, runtime = epoch;
  try {
    const response = await invoke('api_request', { request: { path: '/functions/tud-account-usage-summary', method: 'GET', body: null } });
    if (request !== sequence || runtime !== epoch || response.status !== 200) return;
    const current = todayReading(JSON.parse(response.body));
    if (!current) return;
    const message = petFeedback(previous, current);
    previous = current;
    if (celebrate && message) show(message);
    return current;
  } catch { if (request === sequence) { previous = null; show(runtimePhase === 'failed' ? '本地服务已停止' : '本地服务正在恢复'); } }
}
function apply(prefs) {
  enabled = prefs.enabled;
  if (!enabled) { previous = null; epoch++; bubble.hidden = true; }
  pet = prefs.selectedPetId; frame = 0;
  sprite.style.backgroundImage = `url('/pets/${pet}.webp')`;
  paintPetSpriteFrame(sprite, pet, 'idle', frame, 96, 104);
}
const clock = setInterval(() => { if (enabled) paintPetSpriteFrame(sprite, pet, 'idle', ++frame, 96, 104); }, 180);
sprite.addEventListener('click', () => { if (dragged) { dragged = false; return; } void refresh().then(reading => { if (reading) show(`今日\n${Math.round(reading.tokens).toLocaleString()} tokens`); }); });
sprite.addEventListener('dblclick', () => { void invoke('window_action', { action: 'show' }); });
let press = null, dragged = false;
sprite.addEventListener('pointerdown', event => { if (event.button === 0) { dragged = false; press = { x: event.clientX, y: event.clientY }; } });
sprite.addEventListener('pointermove', event => {
  if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
    press = null; dragged = true; void invoke('pet_drag').catch(() => {});
  }
});
window.addEventListener('pointerup', () => { press = null; });
let disposed = false;
async function listen(event, callback) {
  const stop = await window.__TAURI__.event.listen(event, message => { if (!disposed) callback(message.payload); });
  if (disposed) stop(); else stops.push(stop);
}
void listen('desktop-pet:preferences', apply);
void listen('tud:data-synced', () => { void refresh(true); });
function applyRuntime(status) {
  runtimePhase = status.phase;
  if (status.phase !== 'ready') { epoch++; previous = null; if (status.phase === 'failed') show('本地服务已停止'); }
  else { void refresh(); }
}
void listen('tud:runtime-status', status => { runtimeReceived = true; applyRuntime(status); });
void invoke('runtime_status').then(status => { if (!runtimeReceived) applyRuntime(status); });
void invoke('pet_get').then(apply);
void refresh();
window.addEventListener('unload', () => { disposed = true; clearInterval(clock); clearTimeout(bubbleTimer); stops.forEach(stop => stop()); });

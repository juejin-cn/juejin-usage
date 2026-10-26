import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../src-tauri/src/bridge.js', import.meta.url), 'utf8');
function setup() {
  const invokes = [], fetches = [], events = [];
  const listeners = new Map();
  const window = { __TAURI__: { event: { listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } }, core: { invoke: async (command, args) => {
    invokes.push({ command, args }); return { status: 200, body: '{"success":true,"data":{}}' };
  } } }, dispatchEvent: event => events.push(event), fetch: async (...args) => { fetches.push(args); return new Response('{}'); } };
  const context = { navigator: {platform:'MacIntel'}, window, Request, Response, URL, CustomEvent, location: { href: 'http://tauri.localhost/dashboard', origin: 'http://tauri.localhost', pathname: '/dashboard' }, document: { addEventListener() {} }, history: { replaceState() {} } };
  vm.runInNewContext(script, context);
  return { window, invokes, fetches, events, listeners };
}
test('bundled dashboard sends local GET and config writes through IPC', async () => {
  const { window, invokes, fetches } = setup();
  const response = await window.fetch('/functions/tud-config', { method: 'PUT', body: '{"juejin":{"enabled":false}}' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(invokes[0])), { command: 'api_request', args: { request: { path: '/functions/tud-config', method: 'PUT', body: '{"juejin":{"enabled":false}}' } } });
  assert.equal(fetches.length, 0);
  await window.fetch('/functions/tud-usage-daily?days=30');
  assert.equal(invokes[1].args.request.path, '/functions/tud-usage-daily?days=30');
});
test('public API and non-contract requests keep normal fetch', async () => {
  const { window, invokes, fetches } = setup();
  await window.fetch('https://api.juejin.cn/aiusage_api/functions/tud-pricing');
  await window.fetch('/assets/icon.svg');
  assert.equal(invokes.length, 0); assert.equal(fetches.length, 2);
});
test('Request input retains the body and method', async () => {
  const { window, invokes } = setup();
  await window.fetch(new Request('http://tauri.localhost/functions/tud-config', { method: 'PUT', body: '{}' }));
  assert.equal(invokes[0].args.request.method, 'PUT');
  assert.equal(invokes[0].args.request.body, '{}');
});

test('native settings and subscription events reach the existing dashboard shell', async () => {
  const {listeners, events}=setup();
  listeners.get('app:open-settings')({payload:{tab:'subscription'}});
  assert.equal(events[0].type,'tud:open-settings');
  assert.equal(events[0].detail.tab,'subscription');
});
test('event cleanup also works when unmounted before asynchronous registration resolves', async () => {
  const {window,listeners}=setup(); let called=false;
  const stop=window.tud.onJuejinLinkResult(()=>{called=true;});
  stop();
  listeners.get('app:juejin-link-result')?.({payload:{ok:true}});
  await Promise.resolve();
  assert.equal(called,false);
  assert.equal(listeners.has('app:juejin-link-result'),false);
});
test('window controls, native theme and external popups use narrow commands', async () => {
  const {window,invokes}=setup();
  await window.tud.close(); await window.tud.setThemeMode('system');
  window.open('https://juejin.cn/aiusage/rank','_blank');
  assert.deepEqual(JSON.parse(JSON.stringify(invokes)),[
    {command:'window_action',args:{action:'hide'}},
    {command:'theme_set',args:{mode:'system'}},
    {command:'open_external',args:{href:'https://juejin.cn/aiusage/rank'}},
  ]);
});

test('native sync push reaches the existing dashboard reload event', () => {
  const {listeners,events}=setup();listeners.get('tud:data-synced')({payload:null});
  assert.equal(events[0].type,'tud:data-synced');
});
test('runtime notice is read without consuming it until the renderer acknowledges', async () => {
  const {window,invokes}=setup();
  await window.tud.getRuntimeStatus();await window.tud.getRuntimeNotice();await window.tud.acknowledgeRuntimeNotice(2);
  assert.deepEqual(JSON.parse(JSON.stringify(invokes)),[
    {command:'runtime_status'}, {command:'runtime_notice'}, {command:'runtime_ack_notice',args:{id:2}},
  ]);
});

test('custom titlebar drag and maximize retain narrow native actions', async () => {
  const {window, invokes} = setup();
  assert.equal(window.tud.platform, 'darwin');
  await window.tud.startDragging();
  await window.tud.toggleMaximize();
  await window.tud.minimize();
  assert.deepEqual(invokes.map(call => call.args.action), ['drag', 'maximize', 'minimize']);
});

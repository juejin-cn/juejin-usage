import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../src-tauri/src/bridge.js', import.meta.url), 'utf8');
function setup() {
  const invokes = [], fetches = [];
  const window = { __TAURI__: { core: { invoke: async (command, args) => {
    invokes.push({ command, args }); return { status: 200, body: '{"success":true,"data":{}}' };
  } } }, fetch: async (...args) => { fetches.push(args); return new Response('{}'); } };
  const context = { window, Request, Response, URL, location: { href: 'http://tauri.localhost/dashboard', origin: 'http://tauri.localhost', pathname: '/dashboard' }, document: { addEventListener() {} }, history: { replaceState() {} } };
  vm.runInNewContext(script, context);
  return { window, invokes, fetches };
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

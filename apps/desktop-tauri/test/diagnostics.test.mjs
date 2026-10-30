import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
test('pre-module diagnostics report resource and mount failures without error secrets', () => {
  const script=readFileSync(new URL('../src-tauri/src/diagnostics.js',import.meta.url),'utf8');
  const calls=[], listeners=new Map(), timeouts=[];
  vm.runInNewContext(script,{
    window:{__TAURI__:{core:{invoke:async(command,args)=>calls.push({command,args})}},addEventListener:(name,fn)=>listeners.set(name,fn)},
    location:{pathname:'/dashboard',href:'tauri://localhost/dashboard?secret=private'},URL,
    document:{addEventListener:(name,fn)=>listeners.set(name,fn),getElementById:()=>({childElementCount:0})},
    MutationObserver:class{observe(){}disconnect(){}},setTimeout:fn=>timeouts.push(fn),
  });
  listeners.get('error')({target:{src:'tauri://localhost/assets/broken.js?token=private'}});
  listeners.get('unhandledrejection')({reason:new TypeError('private-token')});
  listeners.get('DOMContentLoaded')();timeouts[0]();
  assert.deepEqual(calls.map(call=>call.args.kind),['bridge-ready','resource-error','unhandled-rejection','dom-ready','mount-timeout']);
  assert.equal(calls[1].args.path,'/assets/broken.js');
  assert.equal(JSON.stringify(calls).includes('private'),false);
});

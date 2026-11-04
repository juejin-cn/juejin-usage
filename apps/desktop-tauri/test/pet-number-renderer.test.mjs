import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function fixture() {
  const roots=[];
  const component=()=>{};
  const exports={};
  const source=readFileSync(new URL('../../../packages/dashboard/src/pet/number-renderer.tsx',import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(js,{exports,require(name){
    if(name==='react-dom/client')return {createRoot(element){const root={element,renders:[],render(node){this.renders.push(node);},unmount(){this.unmounted=true;}};roots.push(root);return root;}};
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props})};
    if(name==='../components/AnimatedNumber')return {AnimatedNumber:component};
    if(name==='../lib/format')return {formatTokens:n=>`${n}`,formatUsd:n=>`$${n.toFixed(2)}`};
    throw Error(`Unexpected dependency: ${name}`);
  }});
  return {renderer:exports.createPetNumberRenderer({},{}),roots,component};
}

test('pet numeric slots mount the dashboard AnimatedNumber component and skip unchanged totals',()=>{
  const f=fixture();
  f.renderer.update({tokens:15100000000,cost:3313.78});
  assert.equal(f.roots[0].renders[0].type,f.component);
  assert.equal(f.roots[1].renders[0].type,f.component);
  assert.equal(f.roots[0].renders[0].props.value,15100000000);
  assert.equal(f.roots[1].renders[0].props.format(3313.78),'$3313.78');
  f.renderer.update({tokens:15100000000,cost:3313.78});
  assert.equal(f.roots[0].renders.length,1);
  f.renderer.update({tokens:15200000000,cost:3313.78});
  assert.equal(f.roots[0].renders.length,2);
});

test('loading, failure and hide stay within React roots; disposal releases both roots',()=>{
  const f=fixture();
  f.renderer.loading();assert.equal(f.roots[0].renders.at(-1),'…');
  f.renderer.error();assert.equal(f.roots[0].renders.at(-1),'--');
  f.renderer.update({tokens:1000,cost:1});
  f.renderer.clear();assert.equal(f.roots[0].renders.at(-1),null);
  f.renderer.dispose();assert.ok(f.roots.every(root=>root.unmounted));
});

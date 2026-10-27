import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIcuRuntime, nodeSource } from '../scripts/node-runtime.mjs';
test('small-icu is explicit and verifies source, architecture and binary provenance', () => {
  const runtime={platform:'darwin',arch:'arm64',icuSmall:true,icuVersion:'77.1'};
  const manifest={schemaVersion:1,nodeVersion:nodeSource.nodeVersion,platform:'darwin',arch:'arm64',sourceSha256:nodeSource.sha256,binarySha256:'fixture-hash',configureArgs:['--with-intl=small-icu']};
  assert.throws(()=>validateIcuRuntime(runtime),/Expected full/);
  assert.throws(()=>validateIcuRuntime(runtime,'small'),/verified/);
  assert.deepEqual(validateIcuRuntime(runtime,'small',manifest,'fixture-hash'),{type:'small',version:'77.1'});
  for(const [key,value] of [['sourceSha256','wrong'],['binarySha256','wrong'],['arch','x64'],['nodeVersion','22.22.1'],['configureArgs',[]]]) {
    assert.throws(()=>validateIcuRuntime(runtime,'small',{...manifest,[key]:value},'fixture-hash'),/verified/);
  }
  assert.throws(()=>validateIcuRuntime({...runtime,icuSmall:false},'small',manifest,'fixture-hash'),/Expected small/);
  assert.throws(()=>validateIcuRuntime({...runtime,icuVersion:null},'small',manifest,'fixture-hash'),/include ICU/);
});

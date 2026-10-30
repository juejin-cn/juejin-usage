import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeBuildEnvironment } from '../scripts/signing-env.mjs';

test('empty Actions certificate variables are absent before invoking Tauri', () => {
  const input=Object.freeze({APPLE_CERTIFICATE:'',APPLE_CERTIFICATE_PASSWORD:'',APPLE_SIGNING_IDENTITY:'',APPLE_ID:'',APPLE_PASSWORD:'',APPLE_TEAM_ID:'',PATH:'/bin'});
  for(const debug of [true,false]) {
    const env=nativeBuildEnvironment(input,'darwin',debug);
    assert.equal(env.APPLE_SIGNING_IDENTITY,'-');assert.equal(env.PATH,'/bin');
    for(const key of ['APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID'])assert.equal(Object.hasOwn(env,key),false,key);
  }
  assert.equal(Object.hasOwn(input,'APPLE_CERTIFICATE'),true);
});
test('debug candidates ignore even inherited nonempty signing credentials', () => {
  const env=nativeBuildEnvironment({APPLE_CERTIFICATE:'fixture',APPLE_CERTIFICATE_PASSWORD:'fixture-password',APPLE_SIGNING_IDENTITY:'Developer ID fixture',APPLE_API_KEY:'fixture',APPLE_API_ISSUER:'fixture',APPLE_API_KEY_PATH:'/fixture'},'darwin',true);
  assert.deepEqual(env,{APPLE_SIGNING_IDENTITY:'-'});
});
test('release preserves real certificate credentials including an empty PKCS12 password', () => {
  for(const password of ['', 'fixture-password']) {
    const input={APPLE_CERTIFICATE:'fixture',APPLE_CERTIFICATE_PASSWORD:password,APPLE_SIGNING_IDENTITY:'Developer ID fixture',APPLE_ID:'fixture@example.test'};
    assert.deepEqual(nativeBuildEnvironment(input,'darwin',false),input);
  }
  assert.equal(nativeBuildEnvironment({APPLE_CERTIFICATE:'fixture'},'darwin').APPLE_CERTIFICATE_PASSWORD,'');
  assert.deepEqual(nativeBuildEnvironment({APPLE_SIGNING_IDENTITY:'Developer ID fixture'},'darwin'),{APPLE_SIGNING_IDENTITY:'Developer ID fixture'});
});
test('explicit ad-hoc release excludes certificate import; other platforms retain their environment', () => {
  const input={APPLE_SIGNING_IDENTITY:'-',APPLE_CERTIFICATE:'fixture',APPLE_CERTIFICATE_PASSWORD:'fixture-password'};
  assert.deepEqual(nativeBuildEnvironment(input,'darwin'),{APPLE_SIGNING_IDENTITY:'-'});
  assert.deepEqual(nativeBuildEnvironment(input,'win32',true),input);
});

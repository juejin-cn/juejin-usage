import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localJuejinIdentity } from './tauri-desktop.ts';

test('linked local identity uses display id and clears profile after unlink', () => {
  assert.deepEqual(localJuejinIdentity({juejin:{userId:'jau.synthetic',originUserId:'123',userName:'Tester',avatarLarge:'https://example.com/a.png'}}),{
    authStatus:'authenticated',userId:'123',userName:'Tester',avatarLarge:'https://example.com/a.png',
  });
  assert.deepEqual(localJuejinIdentity({juejin:{userId:null,originUserId:'123',userName:'old',avatarLarge:'old'}}),{
    authStatus:'unauthenticated',userId:null,userName:'',avatarLarge:'',
  });
});

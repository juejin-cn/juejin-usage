import assert from 'node:assert/strict';
import test from 'node:test';
import { __testing } from './desktop-pet-remote.js';

const { definitionFromRemoteManifest, isDirectoryEntry, petRawUrl, rawBase } = __testing;

test('contents entry filter keeps only pet-like directories', () => {
  assert.equal(isDirectoryEntry({ name: 'rimuru', type: 'dir' }), true);
  assert.equal(isDirectoryEntry({ name: 'rimuru', type: 'directory' }), true);
  assert.equal(isDirectoryEntry({ name: 'README.md', type: 'file' }), false);
  assert.equal(isDirectoryEntry({ name: '', type: 'dir' }), false);
  assert.equal(isDirectoryEntry({ type: 'dir' }), false);
});

test('remote raw URLs prefer host-specific bases', () => {
  assert.equal(rawBase('gitee'), 'https://gitee.com/juejin-cn/juejin-usage/raw/main');
  assert.equal(rawBase('github'), 'https://raw.githubusercontent.com/juejin-cn/juejin-usage/main');
  assert.equal(
    petRawUrl('gitee', 'rimuru', 'pet.json'),
    'https://gitee.com/juejin-cn/juejin-usage/raw/main/pets/rimuru/pet.json',
  );
});

test('remote manifest parser rejects mismatched or empty display names', () => {
  assert.equal(
    definitionFromRemoteManifest('rimuru', {
      id: 'other',
      displayName: 'Rimuru',
    }, 'gitee'),
    null,
  );
  assert.equal(
    definitionFromRemoteManifest('rimuru', {
      id: 'rimuru',
      displayName: '   ',
    }, 'gitee'),
    null,
  );
  assert.deepEqual(
    definitionFromRemoteManifest('rimuru', {
      id: 'rimuru',
      displayName: 'Rimuru',
      description: '史莱姆',
      glow: { primary: '#5eb6ea', accent: '#fff4c4' },
    }, 'gitee'),
    {
      id: 'rimuru',
      displayName: 'Rimuru',
      description: '史莱姆',
      glow: { primary: '#5eb6ea', accent: '#fff4c4' },
      source: 'remote',
      previewUrl: 'https://gitee.com/juejin-cn/juejin-usage/raw/main/pets/rimuru/spritesheet.webp',
    },
  );
});

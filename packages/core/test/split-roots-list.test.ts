import assert from 'node:assert/strict';
import test from 'node:test';

import { splitRootsList } from '../src/parsers/shared.js';
import { vscodeHostRoots } from '../src/parsers/roocode.js';

test('splitRootsList keeps Windows drive-letter colons intact', () => {
  assert.deepEqual(splitRootsList('C:\\Users\\dev\\.vscode', 'win32'), [
    'C:\\Users\\dev\\.vscode',
  ]);
  assert.deepEqual(splitRootsList('C:\\r1;C:\\r2', 'win32'), [
    'C:\\r1',
    'C:\\r2',
  ]);
  assert.deepEqual(splitRootsList('C:\\r1,C:\\r2', 'win32'), [
    'C:\\r1',
    'C:\\r2',
  ]);
});

test('splitRootsList splits on the historical separator set off win32', () => {
  assert.deepEqual(splitRootsList('/r1:/r2', 'linux'), ['/r1', '/r2']);
  assert.deepEqual(splitRootsList('/r1;/r2,/r3', 'darwin'), [
    '/r1',
    '/r2',
    '/r3',
  ]);
});

test('splitRootsList trims and drops empty segments', () => {
  assert.deepEqual(splitRootsList(' /r1 ; ; /r2 ', 'linux'), ['/r1', '/r2']);
  assert.deepEqual(splitRootsList('C:\\r1 ; ; C:\\r2', 'win32'), [
    'C:\\r1',
    'C:\\r2',
  ]);
});

test('vscodeHostRoots splits AI_USAGE_VSCODE_ROOTS on ; on every platform', () => {
  // `;` separates on every platform; `:` only off win32 (drive letters).
  const prev = process.env.AI_USAGE_VSCODE_ROOTS;
  process.env.AI_USAGE_VSCODE_ROOTS = '/vscode/a;/vscode/b';
  try {
    assert.deepEqual(vscodeHostRoots(), ['/vscode/a', '/vscode/b']);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_VSCODE_ROOTS;
    else process.env.AI_USAGE_VSCODE_ROOTS = prev;
  }
});

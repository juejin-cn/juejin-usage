import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { prependGuiNodePaths } from './cli-runtime';

test('adds GUI-safe Node locations ahead of Finder PATH without removing it', {
  skip: process.platform !== 'darwin',
}, () => {
  const result = prependGuiNodePaths('/usr/bin:/bin', '/Users/tester');
  const entries = result.split(path.delimiter);
  assert.ok(entries.indexOf('/opt/homebrew/bin') < entries.indexOf('/usr/bin'));
  assert.ok(entries.includes('/usr/local/bin'));
  assert.deepEqual(entries.slice(-2), ['/usr/bin', '/bin']);
});

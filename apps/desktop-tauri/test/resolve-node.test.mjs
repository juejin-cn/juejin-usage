import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { resolveNodeBinary } from '../scripts/resolve-node.mjs';

test('explicit runtime and matching host do not invoke npm', () => {
  const run = () => { throw new Error('unexpected download'); };
  const expected = realpathSync(process.execPath);
  assert.equal(resolveNodeBinary('22.15.0', { env: { TUD_NODE_BIN: process.execPath }, run }), expected);
  assert.equal(resolveNodeBinary('22.15.0', { env: {}, currentVersion: '22.15.0', run }), expected);
});

test('mismatched build Node resolves a pinned sidecar through npm', () => {
  let calls = 0;
  const result = resolveNodeBinary('22.15.0', {
    env: {}, currentVersion: '26.1.0', platform: 'darwin',
    run: (command, args, options) => {
      calls++;
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['exec', '--yes', '--prefer-offline', '--package=node@22.15.0', '--', 'node', '-p', 'process.execPath']);
      assert.equal(options.env.NODE_OPTIONS, '');
      return `${process.execPath}\n`;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result, realpathSync(process.execPath));
});

test('custom builds require explicit runtime and npm errors explain offline recovery', () => {
  assert.throws(() => resolveNodeBinary('22.15.0', { env: { TUD_NODE_ICU: 'small' }, currentVersion: '26.1.0' }), /TUD_NODE_BIN/);
  assert.throws(() => resolveNodeBinary('22.15.0', {
    env: {}, currentVersion: '26.1.0', run: () => { throw new Error('offline'); },
  }), /registry access or set TUD_NODE_BIN/);
});

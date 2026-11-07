import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { readHostBootstrap } from '../dist/host/vault-bootstrap.js';

test('vault bootstrap consumes only a private pipe header and accepts split chunks', async () => {
  const input = new PassThrough(); const key = randomBytes(32); const pending = readHostBootstrap(input, true);
  input.write('BOOT'); input.write('STRAP=' + JSON.stringify({ hostKey: 'test-host', vaultKey: key.toString('base64') }) + '\n');
  assert.deepEqual(await pending, { hostKey: 'test-host', vaultKey: key }); assert.equal(input.listenerCount('data'), 0);
});
test('missing secure store does not invent a file key and malformed pipe input is rejected', async () => {
  const absent = new PassThrough(); assert.deepEqual(await readHostBootstrap(absent, false), {});
  const empty = new PassThrough(); const emptyResult = readHostBootstrap(empty, true); empty.write('BOOTSTRAP=' + JSON.stringify({ hostKey: 'test-host', vaultKey: null }) + '\n'); assert.deepEqual(await emptyResult, { hostKey: 'test-host' });
  const invalid = new PassThrough(); const rejected = readHostBootstrap(invalid, true); invalid.write('VAULT_KEY=bad\n'); await assert.rejects(rejected, /VAULT_BOOTSTRAP_INVALID/);
  const closed = new PassThrough(); const ended = readHostBootstrap(closed, true); closed.end(); await assert.rejects(ended, /VAULT_BOOTSTRAP_CLOSED/);
});

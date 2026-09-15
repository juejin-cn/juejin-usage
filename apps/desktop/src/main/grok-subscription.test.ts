import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hasCustomGrokConfiguration, runGrokBillingRpc } from './grok-subscription';

test('detects custom Grok API keys and endpoint overrides', () => {
  assert.equal(hasCustomGrokConfiguration({ XAI_API_KEY: 'xai-test' }), true);
  assert.equal(hasCustomGrokConfiguration({ GROK_WS_URL: 'https://example.test' }), true);
  assert.equal(hasCustomGrokConfiguration({ XAI_API_KEY: 'false' }), false);
  assert.equal(hasCustomGrokConfiguration({}), false);
});

test('completes the Grok ACP handshake while ignoring non-JSON output', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jusage-grok-test-'));
  const executable = join(directory, 'fake-grok.cjs');
  writeFileSync(executable, `
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
console.log('startup banner');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  const result = request.id === 3
    ? { config: { creditUsagePercent: 42, currentPeriod: { type: 'weekly' } } }
    : {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});
`, 'utf8');
  // Run the fixture through Node on every platform; Windows cannot execute a
  // POSIX shebang script directly. Keep the real child process and stdio RPC.
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (
    command: string,
    args: readonly string[],
    options: childProcess.SpawnOptionsWithoutStdio,
  ) => {
    assert.equal(command, executable);
    assert.deepEqual(args, ['--no-auto-update', 'agent', '--no-leader', 'stdio']);
    return spawn(process.execPath, [executable, ...args], options);
  });
  try {
    assert.deepEqual(await runGrokBillingRpc(executable, directory), {
      config: { creditUsagePercent: 42, currentPeriod: { type: 'weekly' } },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

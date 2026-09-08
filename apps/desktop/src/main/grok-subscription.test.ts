import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('completes the Grok ACP handshake while ignoring non-JSON output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jusage-grok-test-'));
  const executable = join(directory, 'fake-grok');
  writeFileSync(executable, `#!/usr/bin/env node
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
  chmodSync(executable, 0o755);
  try {
    assert.deepEqual(await runGrokBillingRpc(executable, directory), {
      config: { creditUsagePercent: 42, currentPeriod: { type: 'weekly' } },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

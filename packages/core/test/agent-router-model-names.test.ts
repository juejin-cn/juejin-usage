import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayModelName } from '../src/agent-router/model-names.js';
test('model names prefer valid live labels, then configured labels, then the original ID', () => {
  assert.equal(gatewayModelName('codex', 'model', 'Live name', 'Configured'), 'Live name');
  assert.equal(gatewayModelName('codex', 'model', 'bad\nname', 'Configured'), 'Configured');
  for (const name of [undefined, '', 'model', ' model ', 'bad\nname']) assert.equal(gatewayModelName('codex', 'model', name), 'model');
  assert.equal(gatewayModelName(undefined, '__proto__'), '__proto__');
});

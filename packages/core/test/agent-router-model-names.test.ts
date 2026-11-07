import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayModelName } from '../src/agent-router/model-names.js';

test('known Claude IDs get readable labels while upstream and configured labels retain priority', () => {
  assert.equal(gatewayModelName('antigravity', 'claude-sonnet-4-6'), 'Claude Sonnet 4.6');
  assert.equal(gatewayModelName('antigravity', 'claude-opus-4-6-thinking'), 'Claude Opus 4.6 Thinking');
  assert.equal(gatewayModelName('antigravity', 'claude-sonnet-4-6', 'Custom label'), 'Custom label');
  assert.equal(gatewayModelName('qoder', 'qmodel_38max'), 'qmodel_38max');
});
test('model names prefer valid live labels, then configured labels, then the original ID', () => {
  assert.equal(gatewayModelName('codex', 'model', 'Live name', 'Configured'), 'Live name');
  assert.equal(gatewayModelName('codex', 'model', 'bad\nname', 'Configured'), 'Configured');
  for (const name of [undefined, '', 'model', ' model ', 'bad\nname']) assert.equal(gatewayModelName('codex', 'model', name), 'model');
  assert.equal(gatewayModelName(undefined, '__proto__'), '__proto__');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatModelTokens, isFreeModel, modelPresentation } from './model-presentation';

test('only free badges are displayed; other metadata stays in details', () => {
  assert.equal(formatModelTokens(1000000), '1M');
  assert.equal(formatModelTokens(200000), '200K');
  const display = modelPresentation({ capabilities: { vision: true }, limits: { contextTokens: 200000, maxContextTokens: 1000000 }, billing: { multiplier: 0, isFree: true } });
  assert.deepEqual(display.tags, ['免费']);
  assert.deepEqual(modelPresentation({ limits: { contextTokens: 1000000 } }).tags, []);
  assert.deepEqual(modelPresentation({ limits: { contextTokens: 1000000, maxContextTokens: 2000000 } }).tags, []);
  assert.deepEqual(modelPresentation({ limits: { contextTokens: 200000 } }).tags, []);
  assert.deepEqual(modelPresentation(undefined).tags, []);
  assert.deepEqual(modelPresentation({ capabilities: { vision: false } }).tags, []);
  assert.ok(modelPresentation({ capabilities: { vision: false } }).details[0].includes('不支持'));
});

test('expired billing is hidden while capabilities and limits remain visible', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  const m = { capabilities: { vision: true }, limits: { contextTokens: 200000 }, billing: { multiplier: 0.5, originalMultiplier: 1, discountRatio: 0.5, validUntil: new Date(now).toISOString() } };
  assert.deepEqual(modelPresentation(m, now - 1).tags, []);
  assert.deepEqual(modelPresentation(m, now).tags, []);
  assert.ok(modelPresentation(m, now).details.some(line => line.includes('已到期')));
  assert.deepEqual(modelPresentation({ billing: { multiplier: 0, isFree: false } }).tags, []);
  assert.ok(modelPresentation(m, now - 1).details.some(line => line.includes('0.5×')));
  assert.ok(modelPresentation(m).details.some(line => line.includes('VL')));
});

test('free-only filtering excludes paid, unknown and expired account pricing', async () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  assert.equal(isFreeModel({ billing: { isFree: true } }, now), true);
  assert.equal(isFreeModel({ billing: { isFree: false, multiplier: 0 } }, now), false);
  assert.equal(isFreeModel({ billing: { multiplier: 0 } }, now), false);
  assert.equal(isFreeModel(undefined, now), false);
  assert.equal(isFreeModel({ billing: { isFree: true, validUntil: new Date(now).toISOString() } }, now), false);
  assert.equal(isFreeModel({ billing: { isFree: true, validUntil: new Date(now + 1).toISOString() } }, now), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesCursorJson } from '../src/queue/cursor-json.js';

test('cursor comparison preserves JSON escapes, omitted fields, arrays and numeric values', () => {
  const value = { source: { files: { 'a"\\\n😀': { offset: 10, absent: undefined } },
    hashes: ['a', '\\', '\n', '😀', undefined], last: null, number: NaN } };
  const serialized = JSON.stringify(value);
  assert.equal(matchesCursorJson(value, serialized), true);
  assert.equal(matchesCursorJson(value, serialized + ' '), false);
  assert.equal(matchesCursorJson(value, serialized.slice(0, -1)), false);
});

test('cursor comparison catches offset-only changes, deletion and dedup changes', () => {
  const initial = { codex: { files: { a: { offset: 10 } }, seenHashes: ['a', 'b'] } };
  const saved = JSON.stringify(initial);
  const mutated = structuredClone(initial);
  mutated.codex.files.a.offset++;
  assert.equal(matchesCursorJson(mutated, saved), false);
  mutated.codex.files.a.offset--;
  assert.equal(matchesCursorJson(mutated, saved), true);
  mutated.codex.seenHashes.splice(0, 1);
  assert.equal(matchesCursorJson(mutated, saved), false);
  const removed = { codex: { files: {}, seenHashes: ['a', 'b'] } };
  assert.equal(matchesCursorJson(removed, saved), false);
});

test('no-op comparison never serializes the entire cursor file or source collection', () => {
  const files = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i), { offset: i }]));
  const value = { codex: { files, seenHashes: Array.from({ length: 500 }, (_, i) => String(i)) } };
  const saved = JSON.stringify(value);
  const stringify = JSON.stringify;
  JSON.stringify = ((input: unknown, ...args: unknown[]) => {
    assert.notEqual(input, value);
    assert.notEqual(input, value.codex);
    assert.notEqual(input, files);
    assert.notEqual(input, value.codex.seenHashes);
    return Reflect.apply(stringify, JSON, [input, ...args]);
  }) as typeof JSON.stringify;
  try {
    assert.equal(matchesCursorJson(value, saved), true);
  } finally {
    JSON.stringify = stringify;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modelDisplayName,
  modelFamilyKey,
  modelFamilySet,
  modelInFamilySet,
  pickModelDisplayName,
} from './model-family.ts';

test('provider namespaces are dropped from the displayed name', () => {
  assert.equal(modelDisplayName('local/gemini-4-neon'), 'gemini-4-neon');
  assert.equal(modelDisplayName('google/gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(
    modelDisplayName('online-proxy/gemini-4-neon'),
    'gemini-4-neon',
  );
});

test('one model with several spellings collapses into one key', () => {
  assert.equal(
    modelFamilyKey('google/gemini-3.8-flash'),
    modelFamilyKey('gemini-3.8-flash'),
  );
  assert.equal(
    modelFamilyKey('local/gemini-4-neon'),
    modelFamilyKey('online-proxy/gemini-4-neon'),
  );
});

test('the busiest prefix-free spelling is displayed', () => {
  const variants = new Map([
    ['google/gemini-3.8-flash', 64_400],
    ['gemini-3.8-flash', 100_500],
  ]);
  assert.equal(pickModelDisplayName(variants), 'gemini-3.8-flash');
});

test('selection matching uses family keys', () => {
  const selected = modelFamilySet(['gemini-3.8-flash']);
  assert.equal(modelInFamilySet('google/gemini-3.8-flash', selected), true);
  assert.equal(modelInFamilySet('local/gemini-4-neon', selected), false);
});

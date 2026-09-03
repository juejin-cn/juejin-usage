import assert from 'node:assert/strict';
import test from 'node:test';
import { getModelProvider } from './model-provider.ts';

test('getModelProvider maps common model families to their branded providers', () => {
  assert.deepEqual(getModelProvider('anthropic/claude-sonnet-4-6'), {
    key: 'claude',
    label: 'Claude',
    icon: 'claude',
  });
  assert.deepEqual(getModelProvider('openai/codex-mini'), {
    key: 'codex',
    label: 'Codex',
    icon: 'codex',
  });
  assert.deepEqual(getModelProvider('openai/gpt-5'), {
    key: 'openai',
    label: 'OpenAI',
    icon: 'openai',
  });
  assert.deepEqual(getModelProvider('crossmodel/openai/gpt-5.5'), {
    key: 'openai',
    label: 'OpenAI',
    icon: 'openai',
  });
  assert.deepEqual(getModelProvider('google/gemma-4-12b'), {
    key: 'google',
    label: 'Google',
    icon: 'google',
  });
  assert.deepEqual(getModelProvider('alibaba/qwen3.7-flash'), {
    key: 'qwen',
    label: 'Alibaba',
    icon: 'alibaba',
  });
  assert.deepEqual(getModelProvider('deepseek/deepseek-chat'), {
    key: 'deepseek',
    label: 'DeepSeek',
    icon: 'deepseek',
  });
});

test('getModelProvider covers leaderboard aliases without provider namespaces', () => {
  for (const model of [
    'Claude Opus 5 (high)',
    'sonnet-5-thinking',
    'haiku-4-5',
    'fable-5-thinking-max',
  ]) {
    assert.equal(getModelProvider(model).key, 'claude', model);
  }

  for (const model of ['K2.7 Code', 'k3', 'k3-256k']) {
    assert.equal(getModelProvider(model).key, 'moonshot', model);
  }

  assert.equal(getModelProvider('zai_auto').key, 'zhipu');
});

test('getModelProvider falls back to a namespace alias or an Other badge', () => {
  assert.deepEqual(getModelProvider('google-vertex/custom-model'), {
    key: 'google',
    label: 'Google',
    icon: 'google',
  });
  assert.deepEqual(getModelProvider('google-vertex-anthropic/custom-model'), {
    key: 'claude',
    label: 'Claude',
    icon: 'claude',
  });
  assert.deepEqual(getModelProvider('my-local-provider/custom-model'), {
    key: 'unknown',
    label: 'Other',
    icon: 'unknown',
  });
});

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

test('getModelProvider identifies the observed Kimi Desktop alias without guessing other models', () => {
  assert.deepEqual(getModelProvider('k2d8-preview'), {
    key: 'kimi',
    label: 'Kimi',
    icon: 'kimi',
  });
  assert.equal(getModelProvider('k2d8-preview-custom').key, 'unknown');
  assert.equal(getModelProvider('k2d9-preview').key, 'unknown');
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

test('getModelProvider maps Cursor auto/composer and other catalog providers', () => {
  assert.deepEqual(getModelProvider('cursor/auto'), {
    key: 'cursor',
    label: 'Cursor',
    icon: 'cursor',
  });
  assert.deepEqual(getModelProvider('cursor/composer-1.5'), {
    key: 'cursor',
    label: 'Cursor',
    icon: 'cursor',
  });
  assert.deepEqual(getModelProvider('tencent/hy4-preview'), {
    key: 'hunyuan',
    label: 'Tencent',
    icon: 'hunyuan',
  });
  assert.deepEqual(getModelProvider('meituan/longcat-2.0'), {
    key: 'meituan',
    label: 'Meituan',
    icon: 'longcat',
  });
  assert.deepEqual(getModelProvider('inclusionai/ling-3.0-flash'), {
    key: 'inclusionai',
    label: 'InclusionAI',
    icon: 'antgroup',
  });
  assert.deepEqual(getModelProvider('sapiens/agnes-2.5-pro'), {
    key: 'sapiens',
    label: 'Sapiens',
    icon: 'agnesai',
  });
  assert.deepEqual(getModelProvider('xiaomi/mimo-v2-pro'), {
    key: 'xiaomi',
    label: 'Xiaomi',
    icon: 'xiaomimimo',
  });
});

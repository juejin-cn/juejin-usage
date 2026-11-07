import assert from 'node:assert/strict';
import test from 'node:test';
import { isRuntimeTool, runtimeChoice, runtimeSelectionError, type RuntimeView } from './gateway-runtimes.ts';
import type { IntegrationStatus } from '@juejin-opensource/jusage-core/agent-router';

const models = [{ id: 'p/a', name: 'A', provider: 'P' }, { id: 'p/b', name: 'B', provider: 'P' }];
const tool: IntegrationStatus = { id: 'pi', name: 'Pi', icon: 'pi', capability: 'automatic', installed: true, enabled: false, state: 'unconfigured', mode: 'all', models: [], defaultModel: '' };
const view: RuntimeView = { tools: [tool], models, running: true, baseUrl: 'http://127.0.0.1:18453/v1' };

test('new runtime picker includes the supported tools and independent Claude entries, preserving legacy adapters outside the picker', () => {
  for (const id of ['claude', 'claude-vscode', 'claude-desktop', 'codex', 'gemini', 'zcode', 'minimax-code', 'pi', 'opencode', 'deepseek-harness'] as const) assert.equal(isRuntimeTool(id), true);
  for (const id of ['trae', 'cursor-ide', 'cursor-cli'] as const) assert.equal(isRuntimeTool(id), false);
});

test('initial model choices follow all models or preserve a surviving custom selection and default', () => {
  assert.deepEqual(runtimeChoice(tool, models), { mode: 'all', models: ['p/a', 'p/b'], defaultModel: 'p/a' });
  assert.deepEqual(runtimeChoice({ ...tool, mode: 'custom', models: ['p/b', 'removed'], defaultModel: 'p/b' }, models), { mode: 'custom', models: ['p/b'], defaultModel: 'p/b' });
  assert.deepEqual(runtimeChoice({ ...tool, mode: 'custom', models: ['removed'], defaultModel: 'removed' }, models), { mode: 'custom', models: [], defaultModel: '' });
});

test('runtime confirmation blocks unavailable tools, stopped gateway and stale or empty model choices', () => {
  const choice = runtimeChoice(tool, models);
  assert.equal(runtimeSelectionError(view, tool, choice), null);
  assert.match(runtimeSelectionError({ ...view, running: false }, tool, choice)!, /启动网关/);
  assert.match(runtimeSelectionError(view, { ...tool, installed: false }, choice)!, /未检测/);
  assert.match(runtimeSelectionError({ ...view, models: [] }, tool, choice)!, /开放模型/);
  assert.match(runtimeSelectionError(view, tool, { mode: 'custom', models: ['removed'], defaultModel: 'removed' })!, /不可用/);
  assert.match(runtimeSelectionError(view, tool, { ...choice, defaultModel: 'removed' })!, /默认模型/);
  assert.match(runtimeSelectionError(view, { ...tool, capability: 'manual' }, choice)!, /不支持自动/);
  assert.equal(runtimeSelectionError(view, { ...tool, id: 'claude-desktop', capability: 'manual' }, choice), null);
  assert.equal(runtimeSelectionError(view, { ...tool, id: 'deepseek-harness', capability: 'automatic' }, choice), null);
  assert.match(runtimeSelectionError(view, { ...tool, id: 'deepseek-harness', capability: 'manual' }, choice)!, /不支持自动/);
});


test('legacy selections keep the same model when the gateway starts advertising short aliases', () => {
  const aliased = [{ id: 'short/a', legacyId: 'long-id/a', name: 'A', provider: 'P' }, { id: 'short/b', legacyId: 'long-id/b', name: 'B', provider: 'P' }];
  assert.deepEqual(runtimeChoice({ ...tool, mode: 'custom', models: ['long-id/b'], defaultModel: 'long-id/b' }, aliased), { mode: 'custom', models: ['short/b'], defaultModel: 'short/b' });
});

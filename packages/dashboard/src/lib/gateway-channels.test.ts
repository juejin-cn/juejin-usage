import assert from 'node:assert/strict';
import test from 'node:test';
import { makeRouterPreset } from '@juejin-opensource/jusage-core/agent-router/presets';
import { applyAccountExposureDrafts, compareGatewayProviderPriority, groupChannels, setChannelEnabled, applyChannelModelDrafts, applyChannelAccountDrafts } from './gateway-channels.ts';

test('same subscription keeps all accounts in one channel even with mixed availability', () => {
  const first = makeRouterPreset('codex', 'responses');
  const second = { ...first, id: 'second', enabled: false, preset: undefined };
  const groups = groupChannels([first, second, makeRouterPreset('claude', 'messages')]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], [first, second]);
  assert.equal(groups.filter(accounts => !accounts.some(p => p.enabled)).length, 0);
  assert.equal(first.enabled, true);
});

test('API preset accounts merge; unrelated custom configurations stay independent', () => {
  const first = makeRouterPreset('deepseek-api', 'chat');
  const groups = groupChannels([first, { ...first, id: 'second' }, { ...first, id: 'custom-one', preset: 'custom' }, { ...first, id: 'custom-two', preset: 'custom' }]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].length, 2);
});

test('tool toggle updates every account in that channel and preserves other tools', () => {
  const first = makeRouterPreset('codex', 'responses');
  const second = { ...first, id: 'second', enabled: false, preset: undefined };
  const other = makeRouterPreset('claude', 'messages');
  const disabled = setChannelEnabled([first, second, other], first, false);
  assert.deepEqual(disabled.map(p => p.enabled), [false, false, true]);
  assert.equal(disabled[2], other);
  assert.equal(first.enabled, true);
  assert.deepEqual(setChannelEnabled(disabled, second, true).map(p => p.enabled), [true, true, true]);
});

test('model drafts save independently for each account without changing other channels', () => {
  const first = makeRouterPreset('codex', 'responses');
  const second = { ...first, id: 'second' };
  const other = makeRouterPreset('claude', 'messages');
  const originalModels = [...first.models];
  const result = applyChannelModelDrafts([first, second, other], first, { [first.id]: ['one'], second: ['two'], [other.id]: ['unrelated'] });
  assert.deepEqual(result.map(p => p.models), [['one'], ['two'], other.models]);
  assert.equal(result[2], other);
  assert.deepEqual(first.models, originalModels);
  assert.deepEqual(applyChannelModelDrafts([first], first, { [first.id]: [] })[0].models, []);
});


test('account edits remain independent and preserve models, credentials and other subscriptions', () => {
  const first = makeRouterPreset('codex', 'responses');
  const second = { ...first, id: 'second', enabled: false };
  const other = makeRouterPreset('claude', 'messages');
  const result = applyChannelAccountDrafts([first, second, other], first, {
    [first.id]: { name: '  工作  ', enabled: false },
    second: { name: '个人', enabled: true },
    [other.id]: { name: '不可修改', enabled: false },
  });
  assert.deepEqual(result.map(p => [p.name, p.enabled]), [['工作', false], ['个人', true], [other.name, other.enabled]]);
  assert.equal(result[0].auth, first.auth);
  assert.equal(result[0].models, first.models);
  assert.equal(result[2], other);
  assert.equal(first.enabled, true);
  assert.equal(second.enabled, false);
});

test('blank account notes retain the saved name and do not reset enablement', () => {
  const first = makeRouterPreset('codex', 'responses');
  const result = applyChannelAccountDrafts([first], first, { [first.id]: { name: '  ' } });
  assert.equal(result[0].name, first.name);
  assert.equal(result[0].enabled, first.enabled);
});

test('exposure edits affect only the selected account and retain available models', () => {
  const first = { ...makeRouterPreset('codex', 'responses'), models: ['one', 'two'], excludedModels: ['two'] };
  const second = { ...first, id: 'second' };
  const result = applyAccountExposureDrafts([first, second], { [first.id]: { one: false } });
  assert.deepEqual(result[0].excludedModels, ['one', 'two']);
  assert.deepEqual(result[0].models, ['one', 'two']);
  assert.equal(result[1], second);
  assert.deepEqual(first.excludedModels, ['two']);
  const restored = applyAccountExposureDrafts(result, { [first.id]: { one: true, two: true } });
  assert.deepEqual(restored[0].excludedModels, []);
});

test('queued account drafts preserve other account edits and ignore removed catalog entries', () => {
  const first = { ...makeRouterPreset('codex', 'responses'), models: ['one', 'two'] };
  const second = { ...first, id: 'second', enabled: false };
  const result = applyAccountExposureDrafts([first, second], {
    [first.id]: { one: false, removed: false }, second: { two: false }, missing: { one: false },
  });
  assert.deepEqual(result[0].excludedModels, ['one']);
  assert.deepEqual(result[1].excludedModels, ['two']);
  assert.equal(result[1].enabled, false);
});

test('gateway provider priority lists mainstream channels before the long tail', () => {
  assert.ok(compareGatewayProviderPriority('trae-cn', 'github-copilot') < 0);
  assert.ok(compareGatewayProviderPriority('codex', 'kiro') < 0);
  assert.ok(compareGatewayProviderPriority('unknown-a', 'unknown-b') < 0);
  assert.deepEqual(
    ['github-copilot', 'minimax-code', 'trae-cn', 'grok', 'workbuddy', 'codex', 'claude'].sort(compareGatewayProviderPriority),
    ['claude', 'codex', 'workbuddy', 'grok', 'trae-cn', 'minimax-code', 'github-copilot'],
  );
});

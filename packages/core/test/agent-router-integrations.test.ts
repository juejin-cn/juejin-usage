import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AgentGateway } from '../src/agent-router/gateway.js';
import { RouterCredentials } from '../src/agent-router/auth.js';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentIntegrations, type IntegrationContext } from '../src/agent-router/integrations/manager.js';
import { integrationPaths, type IntegrationEnvironment, type IntegrationTool } from '../src/agent-router/integrations/adapters.js';
import { document, editValue } from '../src/agent-router/integrations/edit.js';
import { RouterCredentialStore } from '../src/agent-router/credential-store.js';
const context: IntegrationContext = { running: true, baseUrl: 'http://127.0.0.1:18453/v1', token: 'sk-gateway-fixture', models: [{ id: 'provider/model-a', name: 'Model A', provider: 'Provider' }, { id: 'provider/model-b', name: 'Model B', provider: 'Provider' }] };
const all = { mode: 'all' as const, models: [], defaultModel: context.models[0].id };
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'integration-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const environment: IntegrationEnvironment = { home: join(root, 'home'), platform: 'darwin', env: { PATH: '' }, dataDir: join(root, 'managed') };
  const bin = join(environment.home, '.local', 'bin'); await mkdir(bin, { recursive: true });
  for (const name of ['opencode', 'claude', 'codex', 'gemini', 'zcode', 'mcode', 'pi', 'dsh']) await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const extension = join(environment.home, '.vscode', 'extensions', 'anthropic.claude-code-fixture'); await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'package.json'), '{"publisher":"anthropic","name":"claude-code"}');
  const store = new RouterCredentialStore(join(root, 'vault', 'credentials.enc'), Buffer.alloc(32, 49)); await store.init();
  const manager = new AgentIntegrations(store, environment); await manager.init();
  const paths = integrationPaths(environment);
  const put = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
  return { root, environment, store, manager, paths, put };
}
test('JSONC and TOML edits preserve unrelated comments, tables, quoted and multiline values', () => {
  const json = '{\n // retained\n "other": 1, "model": "old",\n}\n';
  const edited = editValue(json, 'json', ['model'], { present: true, value: 'new' }); assert.match(edited, /\/\/ retained/); assert.equal(document(edited, 'json').other, 1);
  for (const toml of ["# retained\nmodel = '''old\nmodel''' # model comment\n[other]\nkey = 7\n", 'model = "old"\nmodel_providers = { jusage = { name = "old", extra = true } }\n', 'model = "old"\n[model_providers.jusage]\nname = "old" # retained\n']) {
    let updated = editValue(toml, 'toml', ['model'], { present: true, value: 'new' });
    updated = editValue(updated, 'toml', ['model_providers', 'jusage', 'name'], { present: true, value: 'jusage' });
    updated = editValue(updated, 'toml', ['model_providers', 'jusage', 'base_url'], { present: true, value: context.baseUrl });
    assert.equal(document(updated, 'toml').model, 'new'); assert.equal(document(updated, 'toml').model_providers.jusage.base_url, context.baseUrl);
    if (toml.includes('# retained')) assert.match(updated, /# retained/);
    if (toml.includes('extra')) assert.equal(document(updated, 'toml').model_providers.jusage.extra, true);
  }
});
for (const id of ['opencode', 'claude', 'codex', 'zcode'] as IntegrationTool[]) test(`${id}: reversible configuration, unrelated changes and encrypted backup`, async t => {
  const f = await fixture(t); const path = f.paths[id as 'claude']; const original = id === 'codex' ? '# user comment\nmodel = "original"\n[unrelated]\nvalue = 42\n' : '{\n // user comment\n "theme": "dark", "model": "original"\n}\n';
  await f.put(path, original);
  await f.manager.update(id, all, context);
  const text = await readFile(path, 'utf8'); assert.match(text, /user comment/); assert.match(text, /jusage|ANTHROPIC_BASE_URL/);
  const view = await f.manager.list(context); assert.equal(view.tools.find(tool => tool.id === id)?.state, 'connected'); assert.ok(!JSON.stringify(view).includes(context.token));
  assert.ok(!(await readFile(join(f.root, 'vault', 'credentials.enc'), 'utf8')).includes('original'));
  await f.manager.remove(id);
  if (id === 'codex') {
    const restored = document(await readFile(path, 'utf8'), 'toml');
    assert.equal(restored.model, 'original'); assert.equal(restored.model_provider, undefined);
    assert.equal(restored.model_providers.jusage.name, 'jusage');
  } else assert.equal(await readFile(path, 'utf8'), original);
  // Reconnect, then edit an unrelated field before restoring managed fields.
  await f.manager.update(id, all, context);
  const format = id === 'codex' ? 'toml' : 'json';
  const changed = editValue(await readFile(path, 'utf8'), format, ['custom_setting'], { present: true, value: 'keep' });
  await writeFile(path, changed); await f.manager.remove(id);
  const restored = document(await readFile(path, 'utf8'), format); assert.equal(restored.custom_setting, 'keep'); assert.equal(restored.model, 'original');
  if (id === 'codex') assert.equal(restored.model_providers?.jusage.name, 'jusage', 'retain a valid provider for existing sessions');
});
test('Codex disconnect preserves original provider and protects external provider additions', async t => {
  const f = await fixture(t);
  await f.put(f.paths.codex, '[model_providers.jusage]\nname = "Original"\ncustom = true\n');
  await f.manager.update('codex', all, context);
  await writeFile(f.paths.codex, editValue(await readFile(f.paths.codex, 'utf8'), 'toml', ['other'], { present: true, value: 'keep' }));
  await f.manager.remove('codex');
  assert.deepEqual(document(await readFile(f.paths.codex, 'utf8'), 'toml').model_providers.jusage, { name: 'Original', custom: true });
  await f.put(f.paths.codex, '# no original provider\n');
  await f.manager.update('codex', all, context);
  const external = editValue(await readFile(f.paths.codex, 'utf8'), 'toml', ['model_providers', 'jusage', 'custom'], { present: true, value: true });
  await writeFile(f.paths.codex, external);
  await f.manager.remove('codex');
  const restored = document(await readFile(f.paths.codex, 'utf8'), 'toml');
  assert.equal(restored.model_provider, undefined);
  assert.equal(restored.model_providers.jusage.custom, true);
  assert.equal(restored.model_providers.jusage.name, 'jusage');
});
test('Codex disconnect keeps externally selected model/provider and referenced catalog', async t => {
  const f = await fixture(t); await f.put(f.paths.codex, '# original\n');
  await f.manager.update('codex', all, context);
  let text = await readFile(f.paths.codex, 'utf8');
  for (const [key, value] of [
    [['model'], 'external-model'], [['model_provider'], 'other'],
    [['model_providers', 'other', 'name'], 'Other'],
    [['profiles', 'saved', 'model_provider'], 'jusage'],
    [['profiles', 'saved', 'model_catalog_json'], f.paths.catalog],
  ] as [string[], string][]) text = editValue(text, 'toml', key, { present: true, value });
  await writeFile(f.paths.codex, text);
  const catalog = await readFile(f.paths.catalog, 'utf8');
  await f.manager.remove('codex');
  const restored = document(await readFile(f.paths.codex, 'utf8'), 'toml');
  assert.equal(restored.model, 'external-model'); assert.equal(restored.model_provider, 'other');
  assert.equal(restored.model_catalog_json, undefined);
  assert.equal(restored.model_providers.jusage.name, 'jusage');
  assert.equal(await readFile(f.paths.catalog, 'utf8'), catalog);
  assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === 'codex')?.enabled, false);
});
test('Codex disconnect does not restore a catalog reference whose file disappeared', async t => {
  const f = await fixture(t);
  await f.put(f.paths.codex, 'model_catalog_json = "old-models.json"\n');
  await f.manager.update('codex', all, context);
  await f.manager.remove('codex');
  assert.equal(document(await readFile(f.paths.codex, 'utf8'), 'toml').model_catalog_json, undefined);
  await assert.rejects(readFile(f.paths.catalog), { code: 'ENOENT' });
});
test('disconnect preserves externally removed files and modified model catalog', async t => {
  const f = await fixture(t); await f.put(f.paths.codex, '# original\n');
  await f.manager.update('codex', all, context);
  await rm(f.paths.codex);
  const changed = editValue(await readFile(f.paths.catalog, 'utf8'), 'json', ['models'], { present: true, value: [{ slug: 'user-model' }] });
  await writeFile(f.paths.catalog, changed);
  await f.manager.remove('codex');
  await assert.rejects(readFile(f.paths.codex), { code: 'ENOENT' });
  assert.equal(await readFile(f.paths.catalog, 'utf8'), changed);
});
test('ZCode preserves other provider rules and rejects unknown schemas', async t => {
  const f = await fixture(t); await f.put(f.paths.zcode, '{}'); const rules = f.paths.zcode.replace('config.json', 'provider_config.json');
  await f.put(rules, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'other', secret: 'original-secret' }] } } }));
  await f.manager.update('zcode', all, context);
  let parsed = document(await readFile(rules, 'utf8'), 'json'); assert.equal(parsed.config.providerConfigRules.providerRules.length, 2);
  parsed.config.providerConfigRules.providerRules[0].name = 'external edit'; await writeFile(rules, JSON.stringify(parsed));
  await f.manager.remove('zcode'); parsed = document(await readFile(rules, 'utf8'), 'json'); assert.equal(parsed.config.providerConfigRules.providerRules.length, 1); assert.equal(parsed.config.providerConfigRules.providerRules[0].name, 'external edit');
  await writeFile(rules, '{"schemaVersion":99}'); await assert.rejects(f.manager.update('zcode', all, context), /FORMAT_UNSUPPORTED/);
});
test('all follows new models; custom stays selected; removed default falls back; no-model retains configuration', async t => {
  const f = await fixture(t); await f.put(f.paths.opencode, '{}'); await f.manager.update('opencode', all, context);
  const extended = { ...context, models: [...context.models, { id: 'new/model', name: 'New', provider: 'New' }] };
  await f.manager.sync(extended); assert.equal((await f.manager.list(extended)).tools[0].models.length, 3);
  await f.manager.update('opencode', { mode: 'custom', models: ['provider/model-b'], defaultModel: 'provider/model-b' }, extended);
  await f.manager.sync(context); assert.deepEqual((await f.manager.list(context)).tools[0].models, ['provider/model-b']);
  await f.manager.update('opencode', all, context);
  await f.manager.sync({ ...context, models: [context.models[1]] }); assert.equal((await f.manager.list(context)).tools[0].defaultModel, 'provider/model-b');
  const before = await readFile(f.paths.opencode, 'utf8'); await f.manager.sync({ ...context, models: [] }); assert.equal(await readFile(f.paths.opencode, 'utf8'), before);
  assert.equal((await f.manager.list(context)).tools[0].state, 'pending');
});
test('token and port sync preserves baseline; external owned-field edits block sync but allow selective disconnect', async t => {
  const f = await fixture(t); await f.put(f.paths.claude, '{"env":{"ANTHROPIC_AUTH_TOKEN":"old-secret"}}');
  await f.manager.update('claude', all, context);
  await f.manager.sync({ ...context, token: 'new-secret', baseUrl: 'http://127.0.0.1:23456/v1' });
  let text = await readFile(f.paths.claude, 'utf8'); assert.match(text, /23456/); assert.match(text, /new-secret/);
  text = editValue(text, 'json', ['model'], { present: true, value: 'external' }); await writeFile(f.paths.claude, text);
  await f.manager.sync(context); assert.equal(await readFile(f.paths.claude, 'utf8'), text);
  assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === 'claude')?.state, 'conflict');
  await f.manager.remove('claude');
  const restored = document(await readFile(f.paths.claude, 'utf8'), 'json');
  assert.equal(restored.model, 'external'); assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'old-secret');
  assert.equal(restored.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === 'claude')?.enabled, false);
});
test('explicit reconnect applies the selected model and restores the latest external values on disconnect', async t => {
  const f = await fixture(t);
  await f.put(f.paths.claude, '{"model":"original","env":{"ANTHROPIC_AUTH_TOKEN":"original-token"},"theme":"dark"}');
  await f.manager.update('claude', all, context);
  let text = await readFile(f.paths.claude, 'utf8');
  text = editValue(text, 'json', ['model'], { present: true, value: 'external-model' });
  text = editValue(text, 'json', ['env', 'ANTHROPIC_AUTH_TOKEN'], { present: true, value: 'external-token' });
  await writeFile(f.paths.claude, text);
  await assert.rejects(f.manager.update('claude', all, context), /INTEGRATION_CONFLICT/);
  assert.equal(await readFile(f.paths.claude, 'utf8'), text);
  await f.manager.update('claude', { ...all, defaultModel: context.models[1].id, reapply: true }, context);
  assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === 'claude')!.state, 'connected');
  assert.equal(document(await readFile(f.paths.claude, 'utf8'), 'json').model, context.models[1].id);
  // Reconnection is a one-time action, never a persisted auto-overwrite mode.
  text = editValue(await readFile(f.paths.claude, 'utf8'), 'json', ['theme'], { present: true, value: 'light' });
  await writeFile(f.paths.claude, text);
  await f.manager.sync({ ...context, token: 'rotated-key' });
  await f.manager.remove('claude');
  const restored = document(await readFile(f.paths.claude, 'utf8'), 'json');
  assert.equal(restored.model, 'external-model');
  assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, 'external-token');
  assert.equal(restored.theme, 'light');
  assert.equal(restored.env.ANTHROPIC_BASE_URL, undefined);
});

test('reconnect restores external values even through the unchanged-file restore path', async t => {
  const f = await fixture(t); await f.manager.update('pi', all, context);
  await writeFile(f.paths.piSettings, editValue(await readFile(f.paths.piSettings, 'utf8'), 'json', ['defaultModel'], { present: true, value: 'external-model' }));
  await f.manager.update('pi', { ...all, reapply: true }, context);
  const saved = f.store.getDocument<any>('agent-integrations-v1');
  assert.equal(saved.tools.pi.reapply, undefined);
  await f.manager.remove('pi');
  assert.equal(document(await readFile(f.paths.piSettings, 'utf8'), 'json').defaultModel, 'external-model');
});

test('short aliases migrate custom tool selections without changing the selected model or disconnect restore point', async t => {
  const f = await fixture(t); const original = '# original config\nmodel = "before"\n';
  await f.put(f.paths.codex, original);
  const selected = { mode: 'custom' as const, models: [context.models[1].id], defaultModel: context.models[1].id };
  await f.manager.update('codex', selected, context);
  const next = { ...context, models: context.models.map((model, index) => ({ ...model, id: 'short/model-' + index, legacyId: model.id })) };
  await f.manager.sync(next);
  const tool = (await f.manager.list(next)).tools.find(tool => tool.id === 'codex')!;
  assert.equal(tool.state, 'connected'); assert.deepEqual(tool.models, ['short/model-1']); assert.equal(tool.defaultModel, 'short/model-1');
  assert.equal(document(await readFile(f.paths.codex, 'utf8'), 'toml').model, 'short/model-1');
  // An older panel may still submit the long IDs during the migration.
  await f.manager.update('codex', selected, next);
  assert.equal((await f.manager.list(next)).tools.find(tool => tool.id === 'codex')!.defaultModel, 'short/model-1');
  await f.manager.remove('codex');
  assert.equal(document(await readFile(f.paths.codex, 'utf8'), 'toml').model, 'before');
});

for (const id of ['opencode', 'zcode', 'pi', 'minimax-code'] as const) test(`${id}: old managed Chat configuration upgrades to Messages and still restores the original file`, async t => {
  const f = await fixture(t); const format = id === 'minimax-code' ? 'yaml' : 'json';
  const original = format === 'yaml' ? '# before connection\ntheme: dark\n' : '{"theme":"dark"}\n';
  await f.put(f.paths[id], original); await f.manager.update(id, all, context);
  const state = f.store.getDocument<any>('agent-integrations-v1');
  const oldValue = (value: any, key = ''): any => {
    if (Array.isArray(value)) return value.map(v => oldValue(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, oldValue(v, k)]));
    if (key === 'npm' && value === '@ai-sdk/anthropic') return '@ai-sdk/openai-compatible';
    if (key === 'kind' && value === 'anthropic') return 'openai-compatible';
    if (key === 'api' && value === 'anthropic-messages') return 'openai-completions';
    if (key === 'type' && value === 'anthropic-messages') return 'openai-chat-completions';
    if (['baseURL', 'baseUrl'].includes(key) && value === context.baseUrl!.replace(/\/v1$/, '')) return context.baseUrl;
    return value;
  };
  for (const file of state.tools[id].files) {
    let text = file.lastText;
    for (const field of file.fields) {
      field.last.value = oldValue(field.last.value);
      text = editValue(text, file.format, field.key, field.last);
    }
    file.lastText = text; await writeFile(file.path, text);
  }
  await f.store.setDocument('agent-integrations-v1', state);
  const reloaded = new AgentIntegrations(f.store, f.environment); await reloaded.init(); await reloaded.sync(context);
  assert.equal((await reloaded.list(context)).tools.find(tool => tool.id === id)!.state, 'connected');
  const configured = document(await readFile(f.paths[id], 'utf8'), format);
  const provider = id === 'minimax-code' ? configured.custom_provider.jusage : id === 'pi' ? configured.providers.jusage : configured.provider.jusage;
  assert.equal(id === 'opencode' ? provider.npm : id === 'zcode' ? provider.kind : provider.api, id === 'opencode' ? '@ai-sdk/anthropic' : id === 'zcode' ? 'anthropic' : 'anthropic-messages');
  await reloaded.remove(id); assert.equal(await readFile(f.paths[id], 'utf8'), original);
});

test('failed commit rolls back every file and an interrupted write recovers on restart', async t => {
  const f = await fixture(t); await f.put(f.paths.codex, '# original\n');
  const save = f.store.setDocument.bind(f.store); let calls = 0;
  f.store.setDocument = async (...args) => { if (++calls === 2) throw new Error('simulated disk failure'); await save(...args); };
  await assert.rejects(f.manager.update('codex', all, context)); assert.equal(await readFile(f.paths.codex, 'utf8'), '# original\n'); await assert.rejects(readFile(f.paths.catalog), { code: 'ENOENT' });
  f.store.setDocument = save;
  await save('agent-integrations-v1', { version: 1, tools: {}, journal: { id: 'codex', writes: [{ path: f.paths.codex, before: '# original\n', after: 'model="interrupted"\n' }] } });
  await writeFile(f.paths.codex, 'model="interrupted"\n');
  const recovered = new AgentIntegrations(f.store, f.environment); await recovered.init(); assert.equal(await readFile(f.paths.codex, 'utf8'), '# original\n');
  assert.equal(f.store.getDocument<any>('agent-integrations-v1').journal, undefined);
});
test('unknown tools, manual tools, invalid selections, malformed files and symlinks fail before writing', async t => {
  const f = await fixture(t); await f.put(f.paths.opencode, '{broken');
  await assert.rejects(f.manager.update('unknown' as IntegrationTool, all, context), /UNKNOWN/);
  await assert.rejects(f.manager.update('cursor-cli', all, context), /MANUAL_ONLY/);
  await assert.rejects(f.manager.update('opencode', { ...all, mode: 'custom', models: ['unknown'] }, context), /MODEL_UNAVAILABLE/);
  await assert.rejects(f.manager.update('opencode', all, context), /FORMAT_UNSUPPORTED/); assert.equal(await readFile(f.paths.opencode, 'utf8'), '{broken');
  const target = join(f.root, 'target.json'); await f.put(target, '{}'); await rm(f.paths.opencode); await symlink(target, f.paths.opencode);
  await assert.rejects(f.manager.update('opencode', all, context), /PATH_UNSAFE/); assert.equal(await readFile(target, 'utf8'), '{}');
});
test('Windows and macOS paths honor supported user directory overrides', () => {
  const win = integrationPaths({ home: 'C:\\Users\\User', platform: 'win32', env: { HOME: 'D:\\User', CODEX_HOME: 'D:\\Codex', APPDATA: 'C:\\Users\\User\\AppData\\Roaming' }, dataDir: 'D:\\App' });
  assert.equal(win.codex, 'D:\\Codex\\config.toml'); assert.equal(win.zcode, 'D:\\User\\.zcode\\v2\\config.json');
  const mac = integrationPaths({ home: '/Users/test', platform: 'darwin', env: { XDG_CONFIG_HOME: '/Users/test/config', CLAUDE_CONFIG_DIR: '~/claude' }, dataDir: '/app' });
  assert.equal(mac.opencode, '/Users/test/config/opencode/opencode.json'); assert.equal(mac.claude, '/Users/test/claude/settings.json');
  assert.throws(() => integrationPaths({ home: '/home', platform: 'darwin', env: { CODEX_HOME: 'relative' }, dataDir: '/app' }), /PATH_UNSUPPORTED/);
});

for (const id of ['minimax-code', 'pi', 'claude-vscode'] as const) test(`${id}: configure, sync, restart and selectively restore without losing user data`, async t => {
  const f = await fixture(t);
  const configPath = f.paths[id];
  const format = id === 'minimax-code' ? 'yaml' : 'json';
  const original = format === 'yaml' ? '# keep user comment\ndefaultModel: previous/model\ndefaultModelVariant: original-variant\ndefaultModelThinking: {effort: high}\ndefaultModelContextWindow: 32768\ntheme: dark\ncustom_provider:\n  original:\n    options:\n      apiKey: original-secret\n' : '// keep user comment\n{"theme":"dark","claudeCode.environmentVariables":[{"name":"USER_SETTING","value":"original-secret"}]}\n';
  await f.put(configPath, original);
  if (id === 'claude-vscode') await mkdir(join(f.environment.home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.0'), { recursive: true });
  if (id === 'pi') await f.put(f.paths.piSettings, '{"defaultProvider":"original","defaultModel":"old","theme":"dark"}');
  await f.manager.update(id, all, context);
  let configured = document(await readFile(configPath, 'utf8'), format);
  if (id === 'minimax-code') {
    assert.equal(configured.custom_provider.jusage.api, 'anthropic-messages');
    assert.equal(configured.custom_provider.jusage.options.baseURL, context.baseUrl!.replace(/\/v1$/, ''));
    assert.equal(configured.defaultModel, 'custom_provider:jusage/' + context.models[0].id);
    assert.equal(configured.defaultModelVariant, undefined); assert.equal(configured.defaultModelThinking, undefined); assert.equal(configured.defaultModelContextWindow, undefined);
    assert.equal(configured.custom_provider.original.options.apiKey, 'original-secret');
  } else if (id === 'pi') {
    assert.equal(configured.providers.jusage.api, 'anthropic-messages');
    assert.deepEqual(configured.providers.jusage.models.map((m: any) => m.id), context.models.map(m => m.id));
    assert.equal(document(await readFile(f.paths.piSettings, 'utf8'), 'json').defaultProvider, 'jusage');
  } else {
    assert.equal(configured['claudeCode.environmentVariables'].find((e: any) => e.name === 'ANTHROPIC_BASE_URL').value, context.baseUrl!.replace('/v1', ''));
    assert.equal(configured['claudeCode.selectedModel'], context.models[0].id);
    assert.equal(configured['claudeCode.environmentVariables'].find((e: any) => e.name === 'USER_SETTING').value, 'original-secret');
    await assert.rejects(readFile(f.paths.claude), { code: 'ENOENT' });
  }
  assert.match(await readFile(configPath, 'utf8'), /keep user comment/);
  const changed = { ...context, baseUrl: 'http://127.0.0.1:24567/v1', token: 'rotated-secret', models: [...context.models, { id: 'p/new', name: 'New', provider: 'P' }] };
  await f.manager.sync(changed);
  assert.match(await readFile(configPath, 'utf8'), /24567/);
  assert.match(await readFile(configPath, 'utf8'), /rotated-secret/);
  const restoredManager = new AgentIntegrations(f.store, f.environment); await restoredManager.init();
  const status = (await restoredManager.list(changed)).tools.find(tool => tool.id === id)!;
  assert.equal(status.enabled, true); assert.equal(status.state, 'connected'); assert.equal(status.models.length, 3);
  assert.ok(!JSON.stringify(status).includes('rotated-secret'));
  await restoredManager.update(id, { mode: 'custom', models: ['provider/model-b'], defaultModel: 'provider/model-b' }, changed);
  await restoredManager.sync(context);
  assert.deepEqual((await restoredManager.list(context)).tools.find(tool => tool.id === id)!.models, ['provider/model-b']);
  await writeFile(configPath, editValue(await readFile(configPath, 'utf8'), format, ['theme'], { present: true, value: 'light' }));
  await restoredManager.remove(id);
  configured = document(await readFile(configPath, 'utf8'), format);
  assert.equal(configured.theme, 'light');
  assert.match(await readFile(configPath, 'utf8'), /keep user comment/);
  if (id === 'minimax-code') { assert.equal(configured.defaultModel, 'previous/model'); assert.equal(configured.defaultModelVariant, 'original-variant'); assert.deepEqual(configured.defaultModelThinking, { effort: 'high' }); assert.equal(configured.defaultModelContextWindow, 32768); assert.equal(configured.custom_provider.jusage, undefined); }
  if (id === 'pi') { assert.equal(configured.providers.jusage, undefined); assert.equal(document(await readFile(f.paths.piSettings, 'utf8'), 'json').defaultProvider, 'original'); }
  if (id === 'claude-vscode') { assert.equal(configured['claudeCode.selectedModel'], undefined); assert.deepEqual(configured['claudeCode.environmentVariables'], [{ name: 'USER_SETTING', value: 'original-secret' }]); }
});

test('YAML preserves comments and rejects duplicate keys, aliases, scalars and malformed collections', () => {
  const edited = editValue('# retained\ntheme: dark # retained inline\n', 'yaml', ['custom_provider', 'jusage'], { present: true, value: { api: 'openai-completions' } });
  assert.match(edited, /# retained/); assert.match(edited, /# retained inline/);
  assert.equal(document(edited, 'yaml').theme, 'dark');
  assert.equal(document(editValue('# empty config\n', 'yaml', ['defaultModel'], { present: true, value: 'test' }), 'yaml').defaultModel, 'test');
  for (const text of ['theme: dark\ntheme: light\n', 'a: &key value\nb: *key\n', '- item\n', 'literal', 'broken: [']) assert.throws(() => document(text, 'yaml'), /FORMAT_UNSUPPORTED/);
});

test('Claude desktop stores a guided entry without writing files or participating in automatic sync', async t => {
  const f = await fixture(t); await mkdir(join(f.environment.home, 'Applications', 'Claude.app', 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(f.environment.home, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await f.manager.update('claude-desktop', all, context);
  let status = (await f.manager.list(context)).tools.find(tool => tool.id === 'claude-desktop')!;
  assert.equal(status.enabled, true); assert.equal(status.state, 'manual');
  assert.deepEqual(f.store.getDocument<any>('agent-integrations-v1').tools['claude-desktop'].files, []);
  await assert.rejects(readFile(f.paths.claude), { code: 'ENOENT' });
  await f.manager.sync({ ...context, token: 'rotated', models: [] });
  const recovered = new AgentIntegrations(f.store, f.environment); await recovered.init();
  status = (await recovered.list({ ...context, running: false })).tools.find(tool => tool.id === 'claude-desktop')!;
  assert.equal(status.state, 'manual'); assert.equal(status.error, undefined);
  await recovered.remove('claude-desktop'); assert.equal((await recovered.list(context)).tools.find(tool => tool.id === 'claude-desktop')!.enabled, false);
});

test('new tool paths respect Windows and macOS official directory overrides', () => {
  const win = integrationPaths({ home: 'C:\\Users\\Test', platform: 'win32', env: { APPDATA: 'D:\\Roaming', MINIMAX_DATA_DIR: 'D:\\MiniMax', PI_CODING_AGENT_DIR: 'D:\\Pi' }, dataDir: 'D:\\App' });
  assert.equal(win['claude-vscode'], 'D:\\Roaming\\Code\\User\\settings.json'); assert.equal(win['minimax-code'], 'D:\\MiniMax\\config.yaml'); assert.equal(win.piSettings, 'D:\\Pi\\settings.json');
  const mac = integrationPaths({ home: '/Users/test', platform: 'darwin', env: { MAVIS_DATA_DIR: '~/mcode', PI_CODING_AGENT_DIR: '~/pi' }, dataDir: '/app' });
  assert.equal(mac['minimax-code'], '/Users/test/mcode/config.yaml'); assert.equal(mac.pi, '/Users/test/pi/models.json'); assert.equal(mac['claude-vscode'], '/Users/test/Library/Application Support/Code/User/settings.json');
});

test('uninstalling a CLI keeps its integration removable and does not misreport its managed config as installed', async t => {
  const f = await fixture(t); await f.put(f.paths.opencode, '{"theme":"system"}');
  await f.manager.update('opencode', all, context); await rm(join(f.environment.home, '.local', 'bin', 'opencode'));
  let status = (await f.manager.list(context, true)).tools.find(tool => tool.id === 'opencode')!;
  assert.equal(status.installed, false); assert.equal(status.enabled, true); assert.equal(status.state, 'missing'); assert.equal(status.installation, undefined);
  await assert.rejects(f.manager.update('opencode', all, context), /NOT_INSTALLED/);
  await f.manager.remove('opencode'); assert.equal(await readFile(f.paths.opencode, 'utf8'), '{"theme":"system"}');
  status = (await f.manager.list(context)).tools.find(tool => tool.id === 'opencode')!; assert.equal(status.enabled, false);
});

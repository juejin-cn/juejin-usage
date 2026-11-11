import assert from 'node:assert/strict';
import { test as baseTest, type TestContext } from 'node:test';
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
// These fixtures fake a macOS/Linux install layout. Windows cannot honor the exec bit or POSIX paths they rely on.
const winSkip = process.platform === 'win32' ? 'POSIX install fixtures cannot be faked on Windows' : false;
const pureName = /^(JSONC and TOML|Windows and macOS paths|YAML preserves|new tool paths|YAML sequence editing)/;
type Fn = (t: TestContext) => void | Promise<void>;
function test(name: string, fn: Fn): ReturnType<typeof baseTest>;
function test(name: string, options: object, fn: Fn): ReturnType<typeof baseTest>;
function test(name: string, options: object | Fn, fn?: Fn) {
  const skip = winSkip && !pureName.test(name) ? { skip: winSkip } : {};
  if (typeof options === 'function') return baseTest(name, skip, options as Fn);
  return baseTest(name, { ...options, ...skip }, fn as Fn);
}
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

test('Pi rolls back both files on commit failure and removes created settings on disconnect', async t => {
  const f = await fixture(t); const original = '{"providers":{}}'; await f.put(f.paths.pi, original);
  const save = f.store.setDocument.bind(f.store); let calls = 0;
  f.store.setDocument = async (...args) => { if (++calls === 2) throw new Error('disk failure'); await save(...args); };
  await assert.rejects(f.manager.update('pi', all, context));
  assert.equal(await readFile(f.paths.pi, 'utf8'), original); await assert.rejects(readFile(f.paths.piSettings), { code: 'ENOENT' });
  f.store.setDocument = save;
  await f.manager.update('pi', all, context); await f.manager.remove('pi');
  assert.equal(await readFile(f.paths.pi, 'utf8'), original); await assert.rejects(readFile(f.paths.piSettings), { code: 'ENOENT' });
});

test('MiniMax conflict preserves external edits, including the external default model', async t => {
  const f = await fixture(t); await f.put(f.paths['minimax-code'], '# original\ndefaultModel: original/model\n');
  await f.manager.update('minimax-code', all, context);
  const text = editValue(await readFile(f.paths['minimax-code'], 'utf8'), 'yaml', ['defaultModel'], { present: true, value: 'external/model' });
  await writeFile(f.paths['minimax-code'], text);
  await f.manager.sync({ ...context, token: 'new-token' });
  assert.equal(await readFile(f.paths['minimax-code'], 'utf8'), text);
  assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === 'minimax-code')!.state, 'conflict');
  await f.manager.remove('minimax-code');
  const remaining = document(await readFile(f.paths['minimax-code'], 'utf8'), 'yaml');
  assert.equal(remaining.defaultModel, 'external/model'); assert.equal(remaining.custom_provider.jusage, undefined);
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

test('all automatic adapter configs route authenticated streaming tool calls through the local gateway', async t => {
  const f = await fixture(t); const seen: any[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: ' + JSON.stringify({ id: 'chat-fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'read_file', arguments: '{"path":"example.txt"}' } }] }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'chat-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('missing listener');
  const gateway = new AgentGateway(new RouterCredentials({ TEST_KEY: 'upstream-fixture-key' }));
  t.after(() => gateway.stop());
  await gateway.start({ version: 1, port: 0, providers: [{ id: 'p', name: 'Provider', enabled: true, protocol: 'chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ['model-a'], auth: { kind: 'env', variable: 'TEST_KEY' } }], groups: [] });
  const live: IntegrationContext = { running: true, baseUrl: gateway.status().baseUrl!, token: gateway.token()!, models: [{ id: 'p/model-a', name: 'A', provider: 'Provider' }] };
  for (const id of ['opencode', 'claude', 'codex', 'zcode', 'minimax-code', 'pi', 'claude-vscode'] as const) {
    const format = id === 'codex' ? 'toml' : id === 'minimax-code' ? 'yaml' : 'json';
    await f.put(f.paths[id], format === 'json' ? '{}' : '# config\n');
    if (id === 'claude-vscode') await mkdir(join(f.environment.home, '.vscode', 'extensions', 'anthropic.claude-code-fixture'), { recursive: true });
    await f.manager.update(id, { mode: 'all', models: [], defaultModel: live.models[0].id }, live);
    const config = document(await readFile(f.paths[id], 'utf8'), format);
    if (id === 'opencode') assert.equal(config.provider.jusage.npm, '@ai-sdk/anthropic');
    if (id === 'zcode') {
      assert.equal(config.provider.jusage.kind, 'anthropic');
      const rules = document(await readFile(f.paths.zcode.replace(/config\.json$/, 'provider_config.json'), 'utf8'), 'json');
      const rule = rules.config.providerConfigRules.providerRules.find((r: any) => r.providerId === 'jusage');
      assert.equal(rule.config.api.type, 'anthropic-messages');
      assert.equal(rule.config.api.baseUrl, live.baseUrl!.replace(/\/v1$/, ''));
    }
    let base: string; let token: string; let model: string; let endpoint = '/chat/completions';
    if (id === 'claude' || id === 'claude-vscode') {
      const env = id === 'claude' ? config.env : Object.fromEntries(config['claudeCode.environmentVariables'].map((entry: any) => [entry.name, entry.value]));
      base = env.ANTHROPIC_BASE_URL; token = env.ANTHROPIC_AUTH_TOKEN; model = env.ANTHROPIC_MODEL; endpoint = '/v1/messages';
    } else if (id === 'codex') {
      base = config.model_providers.jusage.base_url; token = config.model_providers.jusage.experimental_bearer_token; model = config.model; endpoint = '/responses';
    } else if (id === 'pi') {
      base = config.providers.jusage.baseUrl; token = config.providers.jusage.apiKey; model = document(await readFile(f.paths.piSettings, 'utf8'), 'json').defaultModel; endpoint = '/v1/messages';
    } else if (id === 'minimax-code') {
      base = config.custom_provider.jusage.options.baseURL; token = config.custom_provider.jusage.options.apiKey; model = config.defaultModel.slice('custom_provider:jusage/'.length); endpoint = '/v1/messages';
    } else {
      base = config.provider.jusage.options.baseURL; token = config.provider.jusage.options.apiKey; model = config.model.slice('jusage/'.length); endpoint = id === 'opencode' ? '/messages' : '/v1/messages';
    }
    const body = endpoint === '/responses' ? { model, stream: true, input: 'Read a file', tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] } : { model, stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'Read a file' }], tools: endpoint.endsWith('/messages') ? [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] : [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] };
    const response = await fetch(base + endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, id);
    const stream = await response.text(); assert.match(stream, /read_file/, id); assert.match(stream, /example.txt/, id);
    assert.match(stream, endpoint === '/responses' ? /response.completed/ : endpoint.endsWith('/messages') ? /message_stop/ : /\[DONE\]/, id);
    assert.equal(seen.at(-1).body.model, 'model-a', id); assert.equal(seen.at(-1).auth, 'Bearer upstream-fixture-key', id);
  }
  await f.manager.update('deepseek-harness', { mode: 'all', models: [], defaultModel: live.models[0].id }, live);
  const home = join(f.environment.home, '.dsh');
  const rows = document(await readFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), 'yaml-sequence');
  const providers = rows.find((r: any) => r.id === 'llm-pi-ai').config.providers;
  const credentials = document(await readFile(join(home, '.credentials.yaml'), 'utf8'), 'yaml');
  for (const name of ['jusage', 'jusage-responses']) {
    const provider = providers[name]; const messages = provider.api === 'anthropic-messages';
    const model = provider.models[0].id; const token = credentials.refs[provider.apiKeyEnv];
    const tool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
    const body = messages
      ? { model, stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'Read a file' }], tools: [{ name: tool.name, input_schema: tool.parameters }] }
      : { model, stream: true, input: 'Read a file', tools: [{ type: 'function', ...tool }] };
    const response = await fetch(provider.baseURL + (messages ? '/v1/messages' : '/responses'), { method: 'POST', headers: { ...(messages ? { 'x-api-key': token } : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, name);
    const stream = await response.text(); assert.match(stream, /read_file/); assert.match(stream, /example.txt/);
    assert.match(stream, messages ? /message_stop/ : /response.completed/);
    assert.equal(seen.at(-1).body.model, 'model-a'); assert.equal(seen.at(-1).auth, 'Bearer upstream-fixture-key');
  }
  assert.equal(seen.length, 9);
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


test('Gemini settings and dotenv are reversible; comments, quotes and external edits survive', async t => {
  const f = await fixture(t);
  const original = '# retained\r\nexport GEMINI_API_KEY=\'old-key\' # credential\r\nOTHER="line1\nline2"\r\n';
  await f.put(f.paths.gemini, '{"security":{"auth":{"selectedType":"oauth-personal"}},"theme":"old"}');
  await f.put(f.paths.geminiEnv, original);
  await f.manager.update('gemini', all, context);
  const active = await readFile(f.paths.geminiEnv, 'utf8');
  assert.match(active, /# retained/); assert.match(active, /export GEMINI_API_KEY='sk-gateway-fixture' # credential/);
  assert.equal(document(active, 'dotenv').GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:18453');
  assert.equal(document(await readFile(f.paths.gemini, 'utf8'), 'json').security.auth.selectedType, 'gemini-api-key');
  await f.manager.remove('gemini'); assert.equal(await readFile(f.paths.geminiEnv, 'utf8'), original);
  await f.manager.update('gemini', all, context);
  await writeFile(f.paths.geminiEnv, await readFile(f.paths.geminiEnv, 'utf8') + 'NEW_SETTING=keep\r\n');
  await f.manager.remove('gemini');
  const restored = document(await readFile(f.paths.geminiEnv, 'utf8'), 'dotenv');
  assert.equal(restored.GEMINI_API_KEY, 'old-key'); assert.equal(restored.OTHER, 'line1\nline2'); assert.equal(restored.NEW_SETTING, 'keep'); assert.equal(restored.GOOGLE_GEMINI_BASE_URL, undefined);
});
test('Gemini refuses ambiguous dotenv and rolls back the settings transaction', async t => {
  const f = await fixture(t); const settings = '{"model":{"name":"original"}}';
  await f.put(f.paths.gemini, settings); await f.put(f.paths.geminiEnv, 'GEMINI_API_KEY=a\nGEMINI_API_KEY=b\n');
  await assert.rejects(f.manager.update('gemini', all, context), /FORMAT_UNSUPPORTED/);
  assert.equal(await readFile(f.paths.gemini, 'utf8'), settings);
  assert.throws(() => editValue('KEY="unterminated', 'dotenv', ['KEY'], { present: true, value: 'a' }), /FORMAT_UNSUPPORTED/);
});

test('Gemini override diagnostics expose names only and do not alter shell or project configuration', async t => {
  const f = await fixture(t);
  f.environment.env.GEMINI_API_KEY = 'different-key'; f.environment.env.GEMINI_MODEL = 'different-model';
  await f.manager.update('gemini', all, context);
  const result = await f.manager.list(context); const tool = result.tools.find(tool => tool.id === 'gemini')!;
  assert.deepEqual(tool.warnings, ['ENV_OVERRIDE_GEMINI_API_KEY', 'ENV_OVERRIDE_GEMINI_MODEL']);
  assert.ok(!JSON.stringify(result).includes('different-key'));
  assert.equal(f.environment.env.GEMINI_API_KEY, 'different-key');
});

test('Gemini disconnect restores original dotenv interpolation and multiline values after unrelated edits', async t => {
  const f = await fixture(t); const original = 'export GEMINI_API_KEY="${ORIGINAL_KEY}" # keep\nGEMINI_MODEL=\'old\nmodel\'\n';
  await f.put(f.paths.geminiEnv, original); await f.manager.update('gemini', all, context);
  await writeFile(f.paths.geminiEnv, await readFile(f.paths.geminiEnv, 'utf8') + 'OTHER=external\n');
  await f.manager.remove('gemini'); const restored = await readFile(f.paths.geminiEnv, 'utf8');
  assert.ok(restored.startsWith(original)); assert.equal(document(restored, 'dotenv').OTHER, 'external');
});

test('Claude gateway defaults to tool discovery and preserves prior search preferences', async t => {
  const f = await fixture(t);
  await f.put(f.paths.claude, '{"env":{"ENABLE_TOOL_SEARCH":"auto:5","USER_SETTING":"keep"}}');
  await f.manager.update('claude', all, context);
  assert.equal(document(await readFile(f.paths.claude, 'utf8'), 'json').env.ENABLE_TOOL_SEARCH, 'auto:5');
  await f.manager.sync({ ...context, token: 'rotated-token' });
  await f.manager.remove('claude');
  assert.deepEqual(document(await readFile(f.paths.claude, 'utf8'), 'json').env, { ENABLE_TOOL_SEARCH: 'auto:5', USER_SETTING: 'keep' });
  await f.manager.update('claude-vscode', all, context);
  const vscode = document(await readFile(f.paths['claude-vscode'], 'utf8'), 'json');
  assert.deepEqual(vscode['claudeCode.environmentVariables'].find((v: any) => v.name === 'ENABLE_TOOL_SEARCH'), { name: 'ENABLE_TOOL_SEARCH', value: 'true' });
});



test('DeepSeek Harness directly configures all profiles, home overrides, credentials and defaults, then restores originals', async t => {
  const f = await fixture(t); const home = join(f.environment.home, '.dsh');
  const web = join(home, 'profiles', 'web', 'cordis.patch.yml');
  const desktop = join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  const custom = join(home, 'profiles', 'custom', 'cordis.patch.yml');
  const shared = join(home, 'cordis.patch.yml'); const creds = join(home, '.credentials.yaml'); const env = join(home, '.env');
  const original = '# user profile\n- id: llm-pi-ai\n  config:\n    providers:\n      mine:\n        baseURL: https://user.example\n- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n- id: agent-default-model\n  config:\n    provider: mine\n    model: original\n    reasoningEffort: high\n';
  await f.put(web, original); await f.put(custom, '# Custom profile\n'); await f.put(shared, original);
  const originalCreds = 'version: 1\n# private\nrefs:\n  DEEPSEEK_API_KEY: original-fixture\nrecords:\n  llm-pi-ai/mine:\n    kind: api-key\n    key: mine-fixture\n';
  await f.put(creds, originalCreds); await f.put(env, '# original\nOTHER=keep\n');
  await f.manager.update('deepseek-harness', all, context);
  for (const file of [web, desktop, custom, shared]) {
    const data = document(await readFile(file, 'utf8'), 'yaml-sequence');
    const pi = data.find((row: any) => row.id === 'llm-pi-ai').config.providers;
    assert.equal(pi.jusage.api, 'anthropic-messages'); assert.equal(pi.jusage.apiKeyEnv, 'JUSAGE_GATEWAY_KEY');
    assert.equal(pi.jusage.baseURL, context.baseUrl!.replace(/\/v1$/, '')); assert.deepEqual(pi.jusage.models.map((m: any) => m.id), context.models.map(m => m.id));
    assert.equal(pi['jusage-responses'].api, 'openai-responses');
    assert.equal(pi['jusage-responses'].baseURL, context.baseUrl);
    assert.equal(pi['jusage-responses'].apiKeyEnv, 'JUSAGE_GATEWAY_KEY');
    assert.deepEqual(pi['jusage-responses'].models, pi.jusage.models);
    const selected = data.find((row: any) => row.id === 'agent-default-model').config;
    assert.equal(selected.provider, 'jusage'); assert.equal(selected.model, context.models[0].id); assert.equal(selected.reasoningEffort, undefined);
    assert.ok(!(await readFile(file, 'utf8')).includes(context.token));
  }
  const credentials = document(await readFile(creds, 'utf8'), 'yaml');
  assert.equal(credentials.refs.JUSAGE_GATEWAY_KEY, context.token);
  assert.equal(credentials.records['llm-pi-ai/jusage'].key, context.token);
  assert.equal(credentials.records['llm-pi-ai/jusage-responses'].key, context.token);
  assert.equal(credentials.refs.DEEPSEEK_API_KEY, 'original-fixture');
  assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === 'deepseek-harness')!.state, 'connected');
  await f.manager.remove('deepseek-harness');
  assert.equal(await readFile(web, 'utf8'), original); assert.equal(await readFile(shared, 'utf8'), original);
  assert.equal(await readFile(creds, 'utf8'), originalCreds); assert.equal(await readFile(env, 'utf8'), '# original\nOTHER=keep\n');
  await assert.rejects(readFile(desktop), { code: 'ENOENT' });
});

test('Harness sync follows new profiles and key/port/model changes, and removal preserves external edits', async t => {
  const f = await fixture(t); const home = join(f.environment.home, '.dsh');
  await f.manager.update('deepseek-harness', all, context);
  const custom = join(home, 'profiles', 'new-profile', 'cordis.patch.yml'); await f.put(custom, '# added later\n');
  const next = { ...context, baseUrl: 'http://127.0.0.1:19453/v1', token: 'rotated-fixture', models: context.models.slice(1) };
  await f.manager.sync(next);
  let view = await f.manager.list(next); assert.equal(view.tools.find(t => t.id === 'deepseek-harness')!.state, 'connected');
  let text = await readFile(custom, 'utf8');
  assert.match(text, /19453/); assert.match(text, /provider\/model-b/); assert.doesNotMatch(text, /provider\/model-a/);
  // A new external provider in an existing row must survive disconnect.
  text = editValue(text, 'yaml-sequence', [{ field: 'id', value: 'llm-pi-ai' }, 'config', 'providers', 'external'], { present: true, value: { api: 'openai-completions', baseURL: 'https://external.example' } });
  await writeFile(custom, text);
  const creds = join(home, '.credentials.yaml');
  await writeFile(creds, editValue(await readFile(creds, 'utf8'), 'yaml', ['refs', 'EXTERNAL'], { present: true, value: 'keep-fixture' }));
  const recovered = new AgentIntegrations(f.store, f.environment); await recovered.init(); await recovered.remove('deepseek-harness');
  const remaining = document(await readFile(custom, 'utf8'), 'yaml-sequence');
  assert.equal(remaining.find((r: any) => r.id === 'llm-pi-ai').config.providers.external.baseURL, 'https://external.example');
  assert.equal(remaining.find((r: any) => r.id === 'llm-pi-ai').config.providers.jusage, undefined);
  assert.equal(remaining.some((r: any) => r.id === 'agent-default-model'), false);
  const saved = document(await readFile(creds, 'utf8'), 'yaml');
  assert.equal(saved.refs.EXTERNAL, 'keep-fixture'); assert.equal(saved.refs.JUSAGE_GATEWAY_KEY, undefined);
  assert.equal(saved.version, 1, 'external credentials must retain a valid versioned store');
  assert.equal(saved.records, undefined);
});

test('Harness selects Responses for GPT/Codex and Messages for Claude, rotating both credentials', async t => {
  const f = await fixture(t); const home = join(f.environment.home, '.dsh');
  const models = ['codex/gpt-5.5', 'openai/o3', 'custom/codex', 'anthropic/claude-sonnet-4-6'].map(id => ({ id, name: id, provider: 'fixture' }));
  const next = { ...context, models };
  for (const model of models) {
    await f.manager.update('deepseek-harness', { mode: 'all', models: [], defaultModel: model.id }, next);
    const rows = document(await readFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), 'yaml-sequence');
    assert.equal(rows.find((r: any) => r.id === 'agent-default-model').config.provider, model.id.includes('claude') ? 'jusage' : 'jusage-responses');
  }
  await f.manager.sync({ ...next, token: 'rotated-fixture' });
  const saved = document(await readFile(join(home, '.credentials.yaml'), 'utf8'), 'yaml');
  for (const provider of ['jusage', 'jusage-responses']) assert.equal(saved.records['llm-pi-ai/' + provider].key, 'rotated-fixture');
  await f.manager.remove('deepseek-harness');
  await assert.rejects(readFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml')), { code: 'ENOENT' });
});

test('Harness refuses malformed or future credential schemas before any profile writes', async t => {
  const f = await fixture(t); const home = join(f.environment.home, '.dsh');
  const web = join(home, 'profiles', 'web', 'cordis.patch.yml'); await f.put(web, '# unchanged\n');
  await f.put(join(home, '.credentials.yaml'), 'version: 2\nrefs: {}\n');
  await assert.rejects(f.manager.update('deepseek-harness', all, context), /INTEGRATION_FORMAT_UNSUPPORTED/);
  assert.equal(await readFile(web, 'utf8'), '# unchanged\n');
  await f.put(join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\n');
  await f.put(web, '- id: llm-pi-ai\n  config: {}\n- id: llm-pi-ai\n  config: {}\n');
  await assert.rejects(f.manager.update('deepseek-harness', all, context), /INTEGRATION_FORMAT_UNSUPPORTED/);
  assert.equal(await readFile(join(home, '.credentials.yaml'), 'utf8'), 'version: 1\nrefs: {}\n');
});

test('Harness migrates a guided record to automatic configuration and respects DSH_HOME on Linux', async t => {
  const f = await fixture(t); f.environment.platform = 'linux'; f.environment.env.DSH_HOME = join(f.root, 'custom-dsh');
  await f.store.setDocument('agent-integrations-v1', { version: 1, tools: { 'deepseek-harness': { ...all, models: context.models.map(m => m.id), files: [] } } });
  const manager = new AgentIntegrations(f.store, f.environment); await manager.init();
  await manager.update('deepseek-harness', all, context);
  assert.equal((await manager.list(context)).tools.find(tool => tool.id === 'deepseek-harness')!.state, 'connected');
  assert.match(await readFile(join(f.environment.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), /jusage/);
  await assert.rejects(readFile(join(f.environment.home, '.dsh', '.credentials.yaml')), { code: 'ENOENT' });
  await manager.remove('deepseek-harness');
});

test('Harness follows the literal DSH_HOME in its desktop launcher without executing it', async t => {
  const f = await fixture(t); const actualHome = join(f.root, 'desktop data');
  const cli = join(f.environment.home, '.local', 'bin', 'dsh');
  await writeFile(cli, `#!/bin/sh\n# DeepSeek Harness Desktop - dsh command shim (generated)\nexport DSH_HOME='${actualHome}'\ntouch '${join(f.root, 'never-execute')}'\n`, { mode: 0o755 });
  await f.manager.update('deepseek-harness', all, context);
  assert.match(await readFile(join(actualHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), /apiKeyEnv: JUSAGE_GATEWAY_KEY/);
  await assert.rejects(readFile(join(f.root, 'never-execute')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.environment.home, '.dsh', '.env')), { code: 'ENOENT' });
  await f.manager.remove('deepseek-harness');
});

test('YAML sequence editing preserves unrelated expressions and comments and refuses duplicate selectors or aliases', () => {
  const original = '# profile\n- id: unrelated\n  config:\n    expression: !!js process.env.OTHER\n- id: llm-pi-ai\n  config:\n    providers: {}\n';
  const key = [{ field: 'id', value: 'llm-pi-ai' }, 'config', 'providers', 'jusage'];
  const edited = editValue(original, 'yaml-sequence', key, { present: true, value: { baseURL: context.baseUrl } });
  assert.match(edited, /# profile/); assert.match(edited, /!!js process.env.OTHER/);
  assert.equal(document(edited, 'yaml-sequence').find((r: any) => r.id === 'unrelated').config.expression, 'process.env.OTHER');
  assert.throws(() => editValue('- id: duplicate\n- id: duplicate\n', 'yaml-sequence', [{ field: 'id', value: 'duplicate' }, 'config'], { present: true, value: {} }), /INTEGRATION_FORMAT_UNSUPPORTED/);
  assert.throws(() => editValue('- id: x\n  config: &a {}\n- id: y\n  config: *a\n', 'yaml-sequence', key, { present: true, value: {} }), /INTEGRATION_FORMAT_UNSUPPORTED/);
});

test('Harness preserves the legacy flat credential store used by released desktop bundles', async t => {
  const f = await fixture(t); const credentials = join(f.environment.home, '.dsh', '.credentials.yaml');
  const original = '# legacy credential store\nDEEPSEEK_API_KEY: existing-fixture\n';
  await f.put(credentials, original);
  await f.manager.update('deepseek-harness', all, context);
  const saved = document(await readFile(credentials, 'utf8'), 'yaml');
  assert.equal(saved.DEEPSEEK_API_KEY, 'existing-fixture'); assert.equal(saved.JUSAGE_GATEWAY_KEY, context.token);
  assert.equal(saved.version, undefined); assert.equal(saved.refs, undefined);
  await f.manager.remove('deepseek-harness'); assert.equal(await readFile(credentials, 'utf8'), original);
});

test('an old desktop CLI shim does not hide the official Desktop shared home or change its credential format', async t => {
  const f = await fixture(t); const legacy = join(f.root, 'legacy-desktop'); const shared = join(f.environment.home, '.dsh');
  const cli = join(f.environment.home, '.local', 'bin', 'dsh');
  await writeFile(cli, `#!/bin/sh\n# DeepSeek Harness Desktop - dsh command shim (generated)\nexport DSH_HOME='${legacy}'\n`, { mode: 0o755 });
  await f.put(join(legacy, '.credentials.yaml'), 'OLD_KEY: legacy-fixture\n');
  // Simulate the pre-fix connection, which only managed the stale shim home.
  await f.manager.update('deepseek-harness', all, context);
  const desktop = join(shared, 'profiles', 'desktop', 'cordis.patch.yml');
  const original = '# official Desktop profile\n- id: unrelated\n  config:\n    keep: true\n';
  await f.put(desktop, original);
  await f.put(join(shared, 'profiles', 'desktop', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  const creds = join(shared, '.credentials.yaml'); const originalCreds = 'version: 1\nrefs:\n  EXISTING_KEY: official-fixture\n';
  await f.put(creds, originalCreds);
  // Runtime dependencies can be leftovers from the old CLI installation.
  await f.put(join(shared, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js'), '// mapping of credential reference to value\n// typeof value !== "string"\n');
  await f.manager.sync(context);
  const status = (await f.manager.list(context)).tools.find(tool => tool.id === 'deepseek-harness')!;
  assert.equal(status.state, 'connected'); assert.equal(status.error, undefined);
  for (const home of [legacy, shared]) {
    const rows = document(await readFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), 'yaml-sequence');
    assert.equal(rows.find((r: any) => r.id === 'llm-pi-ai').config.providers.jusage.models.length, context.models.length);
  }
  const saved = document(await readFile(creds, 'utf8'), 'yaml');
  assert.equal(saved.version, 1); assert.equal(saved.refs.JUSAGE_GATEWAY_KEY, context.token);
  assert.equal(document(await readFile(join(legacy, '.credentials.yaml'), 'utf8'), 'yaml').JUSAGE_GATEWAY_KEY, context.token);
  await f.manager.remove('deepseek-harness');
  assert.equal(await readFile(desktop, 'utf8'), original); assert.equal(await readFile(creds, 'utf8'), originalCreds);
});

test('explicit DSH_HOME isolates one installation even when an official Desktop profile also exists', async t => {
  const f = await fixture(t); const shared = join(f.environment.home, '.dsh');
  await f.put(join(shared, 'profiles', 'desktop', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  const original = '# another installation\n'; const file = join(shared, 'profiles', 'desktop', 'cordis.patch.yml'); await f.put(file, original);
  f.environment.env.DSH_HOME = join(f.root, 'explicit-dsh');
  await f.manager.update('deepseek-harness', all, context);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.match(await readFile(join(f.environment.env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), /jusage/);
  await f.manager.remove('deepseek-harness'); assert.equal(await readFile(file, 'utf8'), original);
});

for (const id of ['claude', 'claude-vscode'] as const) {
  const key = id === 'claude' ? ['env', 'ENABLE_TOOL_SEARCH'] : ['claudeCode.environmentVariables', { field: 'name', value: 'ENABLE_TOOL_SEARCH' }];
  const value = (text: string) => { const doc = document(text, 'json'); return id === 'claude' ? doc.env?.ENABLE_TOOL_SEARCH : doc['claudeCode.environmentVariables']?.find((item: any) => item.name === 'ENABLE_TOOL_SEARCH')?.value; };
  const preference = (setting: string) => ({ present: true, value: id === 'claude' ? setting : { name: 'ENABLE_TOOL_SEARCH', value: setting } });
  for (const setting of ['false', 'true', 'auto', 'auto:5', '']) test(`${id} preserves user tool search preference ${JSON.stringify(setting)} through sync/restart/disconnect`, async t => {
    const f = await fixture(t); const original = editValue('{"theme":"user"}\n', 'json', key, preference(setting)); await f.put(f.paths[id], original);
    await f.manager.update(id, all, context); assert.equal(value(await readFile(f.paths[id], 'utf8')), setting);
    const restarted = new AgentIntegrations(f.store, f.environment); await restarted.init(); await restarted.sync({ ...context, token: 'rotated-key' });
    assert.equal(value(await readFile(f.paths[id], 'utf8')), setting); await restarted.remove(id); assert.equal(await readFile(f.paths[id], 'utf8'), original);
  });
  test(`${id} defaults search on, preserves a later edit/deletion and restores only owned fields`, async t => {
    const f = await fixture(t); await f.put(f.paths[id], '{"theme":"user"}\n'); await f.manager.update(id, all, context);
    assert.equal(value(await readFile(f.paths[id], 'utf8')), 'true');
    await writeFile(f.paths[id], editValue(await readFile(f.paths[id], 'utf8'), 'json', key, preference('false')));
    assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === id)?.state, 'connected');
    await f.manager.sync(context); assert.equal(value(await readFile(f.paths[id], 'utf8')), 'false');
    await writeFile(f.paths[id], editValue(await readFile(f.paths[id], 'utf8'), 'json', key, { present: false }));
    await f.manager.sync(context); const restarted = new AgentIntegrations(f.store, f.environment); await restarted.init(); await restarted.sync(context);
    assert.equal(value(await readFile(f.paths[id], 'utf8')), undefined); await restarted.remove(id);
    const restored = document(await readFile(f.paths[id], 'utf8'), 'json'); assert.equal(restored.theme, 'user'); assert.equal(value(await readFile(f.paths[id], 'utf8')), undefined);
  });
  test(`${id} migrates an old owned false and restores the original file`, async t => {
    const f = await fixture(t); const original = '{"theme":"user"}\n'; await f.put(f.paths[id], original); await f.manager.update(id, all, context);
    const old = f.store.getDocument<any>('agent-integrations-v1'); const file = old.tools[id].files[0]; const field = file.fields.find((item: any) => JSON.stringify(item.key) === JSON.stringify(key));
    field.last = preference('false'); delete field.preserveUser; delete field.userOwned;
    file.lastText = editValue(file.lastText, 'json', key, field.last); await writeFile(f.paths[id], file.lastText); await f.store.setDocument('agent-integrations-v1', old);
    const restarted = new AgentIntegrations(f.store, f.environment); await restarted.init(); await restarted.sync(context); assert.equal(value(await readFile(f.paths[id], 'utf8')), 'true');
    await restarted.sync(context); await restarted.remove(id); assert.equal(await readFile(f.paths[id], 'utf8'), original);
  });
  test(`${id} restores an original user preference previously overwritten by the old policy`, async t => {
    const f = await fixture(t); const original = editValue('{}\n', 'json', key, preference('auto:5')); await f.put(f.paths[id], original); await f.manager.update(id, all, context);
    const old = f.store.getDocument<any>('agent-integrations-v1'); const file = old.tools[id].files[0]; const field = file.fields.find((item: any) => JSON.stringify(item.key) === JSON.stringify(key));
    field.last = preference('false'); delete field.preserveUser; delete field.userOwned; file.lastText = editValue(file.lastText, 'json', key, field.last);
    await writeFile(f.paths[id], file.lastText); await f.store.setDocument('agent-integrations-v1', old);
    const restarted = new AgentIntegrations(f.store, f.environment); await restarted.init(); await restarted.sync(context);
    assert.equal(value(await readFile(f.paths[id], 'utf8')), 'auto:5'); await restarted.remove(id); assert.equal(await readFile(f.paths[id], 'utf8'), original);
  });
}

for (const id of ['t3code', 'antigravity', 'copilot-cli', 'omp', 'kimi-code', 'qoder', 'grok-build', 'pi'] as const) test(`${id}: connect, shrink catalog, switch and restore`, async t => {
  const f = await fixture(t);
  const commands = { t3code: 't3code', antigravity: '', 'copilot-cli': 'copilot', omp: 'omp', 'kimi-code': 'kimi', qoder: 'qodercli', 'grok-build': 'grok', pi: 'pi' };
  if (id === 'antigravity') {
    const executable = join(f.environment.home, 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity');
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 });
  } else await writeFile(join(f.environment.home, '.local', 'bin', commands[id]), '#!/bin/sh\n', { mode: 0o755 });
  const format = ['kimi-code', 'grok-build'].includes(id) ? 'toml' : id === 'omp' ? 'yaml' : 'json';
  const original = format === 'toml' ? '# preserved\nuser_setting = true\n' : format === 'yaml' ? '# preserved\nuser_setting: true\n' : '{"user_setting":true}\n';
  await f.put(f.paths[id], original);
  if (id === 'copilot-cli') await f.put(f.paths.copilotProviders, JSON.stringify({ providers: [{ name: 'own', baseUrl: 'https://example.test' }], models: [{ id: context.models[0].id, provider: 'own' }] }));
  await f.manager.update(id, all, context);
  assert.equal((await f.manager.list(context)).tools.find(tool => tool.id === id)?.state, 'connected');
  assert.equal(document(await readFile(f.paths[id], 'utf8'), format).user_setting, true);
  const narrowed = { ...context, models: context.models.slice(-1) };
  await f.manager.update(id, { mode: 'all', models: [], defaultModel: narrowed.models[0].id }, narrowed);
  assert.equal((await f.manager.list(narrowed)).tools.find(tool => tool.id === id)?.state, 'connected');
  if (id === 'copilot-cli') {
    const providers = document(await readFile(f.paths.copilotProviders, 'utf8'), 'json');
    assert.equal(providers.models.filter((m: any) => m.provider === 'jusage').length, 1);
    assert.equal(providers.models.find((m: any) => m.provider === 'own').id, context.models[0].id);
    assert.equal(providers.models.find((m: any) => m.provider === 'jusage').id, narrowed.models[0].id);
  }
  await f.manager.remove(id);
  assert.equal(await readFile(f.paths[id], 'utf8'), original);
});

test('new runtime paths honor home overrides and OMP profiles', () => {
  const env: IntegrationEnvironment = { home: '/home/user', platform: 'darwin', dataDir: '/data', env: { T3CODE_HOME: '/custom/t3', COPILOT_HOME: '/custom/copilot', COPILOT_PROVIDERS_CONFIG: '/custom/providers.json', KIMI_CODE_HOME: '/custom/kimi', QODER_CONFIG_DIR: '/custom/qoder', GROK_HOME: '/custom/grok', OMP_PROFILE: 'work' } };
  const paths = integrationPaths(env);
  assert.equal(paths.t3code, '/custom/t3/userdata/settings.json');
  assert.equal(paths['copilot-cli'], '/custom/copilot/settings.json');
  assert.equal(paths.copilotProviders, '/custom/providers.json');
  assert.equal(paths['kimi-code'], '/custom/kimi/config.toml');
  assert.equal(paths.qoder, '/custom/qoder/settings.json');
  assert.equal(paths['grok-build'], '/custom/grok/config.toml');
  assert.equal(paths.omp, '/home/user/.omp/profiles/work/agent/config.yml');
  assert.throws(() => integrationPaths({ ...env, env: { OMP_PROFILE: '../escape' } }), /PATH_UNSUPPORTED/);
});

test('compound JSON selectors preserve same-id models from other providers and reject duplicates', () => {
  const key = ['models', { field: 'id', value: 'shared', where: { provider: 'jusage' } }];
  const original = JSON.stringify({ models: [{ id: 'shared', provider: 'own' }] });
  const text = editValue(original, 'json', key, { present: true, value: { id: 'shared', provider: 'jusage' } });
  assert.equal(document(text, 'json').models.length, 2);
  assert.deepEqual(document(editValue(text, 'json', key, { present: false }), 'json'), document(original, 'json'));
  assert.throws(() => editValue(JSON.stringify({ models: [{ id: 'shared', provider: 'jusage' }, { id: 'shared', provider: 'jusage' }] }), 'json', key, { present: false }), /FORMAT_UNSUPPORTED/);
});

test('model catalogs serialize known capabilities and limits without changing routing IDs', async t => {
  const { adapterPlans } = await import('../src/agent-router/integrations/adapters.js');
  const f = await fixture(t);
  const models = [{ id: 'account/opaque-model', name: 'Friendly Model', provider: 'Account', metadata: { capabilities: { vision: true, reasoning: false, toolCalling: false }, limits: { contextTokens: 96000, outputTokens: 8000 } } }];
  const configs = (id: IntegrationTool, paths = f.paths) => adapterPlans(id, paths, context.baseUrl!, context.token, models, models[0].id).map(plan => {
    let text = plan.format === 'json' ? '{}' : '';
    for (const field of plan.fields) text = editValue(text, plan.format, field.key, { present: field.value !== undefined, value: field.value });
    return document(text, plan.format);
  });
  const pi = configs('pi')[0].providers.jusage.models[0];
  assert.deepEqual(pi, { id: models[0].id, name: 'Friendly Model', contextWindow: 96000, maxTokens: 8000, input: ['text', 'image'], reasoning: false });
  assert.deepEqual(configs('omp')[0].providers.jusage.models[0], pi);
  const qoder = configs('qoder')[0];
  assert.equal(qoder.model.name, 'jusage/account/opaque-model');
  assert.deepEqual(qoder.providers.jusage.models[0], { model: models[0].id, displayName: 'Friendly Model', contextWindow: 96000, maxOutputTokens: 8000, capabilities: { tools: false, vision: true } });
  assert.equal(configs('copilot-cli')[0].models[0].maxPromptTokens, 88000);
  const kimi = configs('kimi-code')[0].models['jusage/' + models[0].id];
  assert.equal(kimi.display_name, 'Friendly Model'); assert.equal(kimi.max_context_size, 96000); assert.equal(kimi.max_output_size, 8000);
  assert.deepEqual(kimi.capabilities, ['image_in']);
  assert.equal(configs('kimi-code', { ...f.paths, 'kimi-code': f.paths.kimiLegacy })[0].models['jusage/' + models[0].id].max_output_size, undefined);
  assert.equal(configs('grok-build')[0].model['jusage/' + models[0].id].context_window, 96000);
  assert.deepEqual(configs('opencode')[0].provider.jusage.models[models[0].id].limit, { context: 96000, output: 8000 });
  assert.equal(configs('codex')[1].models[0].context_window, 96000);
  const { piModel } = await import('../src/agent-router/integrations/model-options.js');
  assert.deepEqual(piModel(context.models[0]), { id: context.models[0].id, name: 'Model A' });
  assert.deepEqual(piModel({ ...models[0], metadata: { limits: { contextTokens: -1, outputTokens: NaN } } }), { id: models[0].id, name: 'Friendly Model' });
});

test('catalog enrichment and default switch stay reversible and retain the display model set', async t => {
  const f = await fixture(t); await f.put(f.paths.pi, '{"other":true}');
  await f.manager.update('pi', all, context);
  const enriched = { ...context, models: context.models.map(m => ({ ...m, name: 'Display ' + m.name, metadata: { limits: { contextTokens: 64000 } } })) };
  await f.manager.sync(enriched);
  await f.manager.update('pi', { ...all, defaultModel: context.models[1].id }, enriched);
  const catalog = JSON.parse(await readFile(f.paths.pi, 'utf8'));
  assert.equal(catalog.providers.jusage.models.length, 2);
  assert.equal(catalog.providers.jusage.models[0].name, 'Display Model A');
  assert.equal(catalog.providers.jusage.models[0].contextWindow, 64000);
  assert.equal(JSON.parse(await readFile(f.paths.piSettings, 'utf8')).defaultModel, context.models[1].id);
  await f.manager.remove('pi'); assert.deepEqual(JSON.parse(await readFile(f.paths.pi, 'utf8')), { other: true });
});

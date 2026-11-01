import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { RouterError } from '../config.js';
import { document, type Format, type KeyPath } from './edit.js';
export const INTEGRATION_TOOLS = [
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', capability: 'automatic' },
  { id: 'claude', name: 'Claude Code', icon: 'claude-code', capability: 'automatic' },
  { id: 'codex', name: 'Codex', icon: 'codex', capability: 'automatic' },
  { id: 'zcode', name: 'ZCode', icon: 'zcode', capability: 'automatic' },
  { id: 'trae', name: 'Trae IDE', icon: 'trae', capability: 'manual' },
  { id: 'cursor-ide', name: 'Cursor IDE', icon: 'cursor', capability: 'manual' },
  { id: 'cursor-cli', name: 'Cursor CLI', icon: 'cursor', capability: 'unsupported' },
] as const;
export type IntegrationTool = typeof INTEGRATION_TOOLS[number]['id'];
export type ModelOption = { id: string; name: string; provider: string };
export interface IntegrationChoice { mode: 'all' | 'custom'; models: string[]; defaultModel: string }
export interface FilePlan { path: string; format: Format; fields: Array<{ key: KeyPath; value: unknown }> }
export interface IntegrationEnvironment { home: string; platform: string; env: NodeJS.ProcessEnv; dataDir: string }
export const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
export const defaultEnvironment = (dataDir: string): IntegrationEnvironment => ({ home: homedir(), platform: process.platform, env: process.env, dataDir });
export function integrationPaths(environment: IntegrationEnvironment) {
  const { home, platform, env, dataDir } = environment; const p = platform === 'win32' ? path.win32 : path.posix;
  const overridden = (value: string | undefined, fallback: string) => {
    if (!value) return fallback;
    if (value.startsWith('~/') || value.startsWith('~\\')) return p.join(home, value.slice(2));
    if (!p.isAbsolute(value)) throw new RouterError('INTEGRATION_PATH_UNSUPPORTED', 409);
    return value;
  };
  const zhome = platform === 'win32' ? overridden(env.HOME, home) : home;
  return {
    opencode: overridden(env.OPENCODE_CONFIG, p.join(overridden(env.XDG_CONFIG_HOME, p.join(home, '.config')), 'opencode', 'opencode.json')),
    claude: p.join(overridden(env.CLAUDE_CONFIG_DIR, p.join(home, '.claude')), 'settings.json'),
    codex: p.join(overridden(env.CODEX_HOME, p.join(home, '.codex')), 'config.toml'),
    catalog: p.join(dataDir, 'codex-models.json'), zcode: p.join(zhome, '.zcode', 'v2', 'config.json'),
  };
}
export async function resolveIntegrationPaths(environment: IntegrationEnvironment) {
  const paths = integrationPaths(environment); const p = environment.platform === 'win32' ? path.win32 : path.posix;
  if (!environment.env.OPENCODE_CONFIG && !await exists(paths.opencode) && await exists(paths.opencode + 'c')) paths.opencode += 'c';
  try {
    const setting = document(await readFile(p.join(p.dirname(paths.zcode), 'setting.json'), 'utf8'), 'json');
    if (typeof setting.dataBaseDir === 'string' && p.isAbsolute(setting.dataBaseDir)) paths.zcode = p.join(setting.dataBaseDir, '.zcode', 'v2', 'config.json');
  } catch { /* An absent bootstrap setting uses ZCode's default directory. */ }
  return paths;
}
export async function detectTool(id: IntegrationTool, environment: IntegrationEnvironment, paths: Awaited<ReturnType<typeof resolveIntegrationPaths>>) {
  const p = environment.platform === 'win32' ? path.win32 : path.posix;
  if (id in paths && await exists(paths[id as 'claude'])) return true;
  const binaries: Partial<Record<IntegrationTool, string[]>> = { opencode: ['opencode'], claude: ['claude'], codex: ['codex'], 'cursor-cli': ['cursor-agent', 'agent'] };
  const dirs = [...(environment.env.PATH ?? '').split(environment.platform === 'win32' ? ';' : ':'), p.join(environment.home, '.local', 'bin'), p.join(environment.home, '.bun', 'bin'), p.join(environment.home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs.filter(Boolean)) for (const binary of binaries[id] ?? []) for (const suffix of environment.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']) if (await exists(p.join(dir, binary + suffix))) return true;
  if (id === 'cursor-cli') return exists(p.join(environment.home, '.cursor', 'cli-config.json'));
  const app = { zcode: 'ZCode', trae: 'TRAE', 'cursor-ide': 'Cursor' }[id as 'zcode'];
  if (!app) return false;
  const candidates = environment.platform === 'darwin' ? [p.join('/Applications', app + '.app'), p.join(environment.home, 'Applications', app + '.app'), p.join(environment.home, 'Library', 'Application Support', app)]
    : [p.join(environment.env.LOCALAPPDATA ?? p.join(environment.home, 'AppData', 'Local'), 'Programs', app), p.join(environment.env.APPDATA ?? p.join(environment.home, 'AppData', 'Roaming'), app)];
  return (await Promise.all(candidates.map(exists))).some(Boolean);
}
export function adapterPlans(id: IntegrationTool, paths: Awaited<ReturnType<typeof resolveIntegrationPaths>>, base: string, token: string, models: ModelOption[], defaultModel: string): FilePlan[] {
  const field = (key: KeyPath, value: unknown) => ({ key, value });
  const map = Object.fromEntries(models.map(model => [model.id, { name: model.name }]));
  if (id === 'opencode') return [{ path: paths.opencode, format: 'json', fields: [
    field(['provider', 'jusage'], { npm: '@ai-sdk/openai-compatible', name: 'jusage', options: { baseURL: base, apiKey: token }, models: map }),
    field(['model'], 'jusage/' + defaultModel),
  ] }];
  if (id === 'claude') return [{ path: paths.claude, format: 'json', fields: [
    field(['env', 'ANTHROPIC_BASE_URL'], base.replace(/\/v1$/, '')), field(['env', 'ANTHROPIC_AUTH_TOKEN'], token),
    field(['env', 'ANTHROPIC_API_KEY'], ''), field(['env', 'ANTHROPIC_MODEL'], defaultModel), field(['model'], defaultModel),
    ...['BEDROCK', 'VERTEX', 'FOUNDRY'].map(kind => field(['env', 'CLAUDE_CODE_USE_' + kind], '0')),
    ...['OPUS', 'SONNET', 'HAIKU'].map(tier => field(['env', 'ANTHROPIC_DEFAULT_' + tier + '_MODEL'], defaultModel)),
    field(['modelPicker'], { replaceBuiltInOptions: true, options: models.map(model => ({ model: model.id, label: model.name, description: 'via jusage' })) }),
  ] }];
  if (id === 'codex') return [
    { path: paths.codex, format: 'toml', fields: [field(['model_provider'], 'jusage'), field(['model'], defaultModel), field(['model_catalog_json'], paths.catalog),
      ...Object.entries({ name: 'jusage', base_url: base, wire_api: 'responses', experimental_bearer_token: token, requires_openai_auth: false }).map(([key, value]) => field(['model_providers', 'jusage', key], value))] },
    { path: paths.catalog, format: 'json', fields: [field(['models'], models.map(model => ({ slug: model.id, display_name: model.name, description: 'via jusage', visibility: 'list', supported_in_api: true, priority: 0, base_instructions: 'You are a coding assistant. Follow the user instructions and repository guidance. Use the available tools to inspect, implement, and verify changes. Preserve unrelated work and report results accurately.', default_reasoning_level: null, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'bytes', limit: 10000 }, experimental_supported_tools: [], service_tiers: [], supported_reasoning_levels: [], shell_type: 'shell_command', input_modalities: ['text'], supports_parallel_tool_calls: true, supports_reasoning_summaries: false, supports_search_tool: false }))) ] },
  ];
  if (id === 'zcode') {
    const rule = { field: 'providerId', value: 'jusage' };
    return [
      { path: paths.zcode, format: 'json', fields: [field(['provider', 'jusage'], { name: 'jusage', kind: 'openai-compatible', enabled: true, source: 'custom', options: { apiKey: token, baseURL: base }, models: map }), field(['model'], 'jusage/' + defaultModel)] },
      { path: paths.zcode.replace(/config\.json$/, 'provider_config.json'), format: 'json', fields: [field(['schemaVersion'], 1),
        field(['config', 'providerConfigRules', 'providerRules', rule], { providerId: 'jusage', providerName: 'jusage', enabled: true, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: token }, api: { type: 'openai-chat-completions', baseUrl: base }, personalModelIds: models.map(m => m.id), modelOrder: models.map(m => m.id) } }),
      ] },
    ];
  }
  throw new RouterError('INTEGRATION_MANUAL_ONLY', 409);
}

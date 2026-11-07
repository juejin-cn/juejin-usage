import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { RouterError } from '../config.js';
import { document, type Format, type KeyPath } from './edit.js';
import { FLEXIBLE_CLIENT_API, FLEXIBLE_CLIENT_NPM, FLEXIBLE_CLIENT_KIND, FLEXIBLE_CLIENT_RULE, flexibleClientBaseUrl } from './protocol.js';
export const INTEGRATION_TOOLS = [
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', capability: 'automatic' },
  { id: 'claude', name: 'Claude Code', icon: 'claude-code', capability: 'automatic' },
  { id: 'claude-vscode', name: 'Claude Code · VS Code', icon: 'claude-code', capability: 'automatic' },
  { id: 'claude-desktop', name: 'Claude Desktop', icon: 'claude-code', capability: 'manual' },
  { id: 'minimax-code', name: 'MiniMax Code', icon: 'minimax-code', capability: 'automatic' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', icon: 'deepseek', capability: 'automatic' },
  { id: 'pi', name: 'Pi', icon: 'pi', capability: 'automatic' },
  { id: 'gemini', name: 'Gemini CLI', icon: 'gemini', capability: 'automatic' },
  { id: 'codex', name: 'Codex', icon: 'codex', capability: 'automatic' },
  { id: 'zcode', name: 'ZCode', icon: 'zcode', capability: 'automatic' },
  { id: 'trae', name: 'Trae IDE', icon: 'trae', capability: 'manual' },
  { id: 'cursor-ide', name: 'Cursor IDE', icon: 'cursor', capability: 'manual' },
  { id: 'cursor-cli', name: 'Cursor CLI', icon: 'cursor', capability: 'unsupported' },
] as const;
export type IntegrationTool = typeof INTEGRATION_TOOLS[number]['id'];
export type ModelOption = { id: string; name: string; provider: string; legacyId?: string };
export interface IntegrationChoice { mode: 'all' | 'custom'; models: string[]; defaultModel: string; reapply?: boolean }
export interface FilePlan { path: string; format: Format; fields: Array<{ key: KeyPath; value: unknown }>; cleanup?: KeyPath[] }
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
    gemini: p.join(home, '.gemini', 'settings.json'),
    geminiEnv: p.join(home, '.gemini', '.env'),
    codex: p.join(overridden(env.CODEX_HOME, p.join(home, '.codex')), 'config.toml'),
    'claude-vscode': p.join(platform === 'darwin' ? p.join(home, 'Library', 'Application Support') : overridden(env.APPDATA, p.join(home, 'AppData', 'Roaming')), 'Code', 'User', 'settings.json'),
    'minimax-code': p.join(overridden(env.MINIMAX_DATA_DIR ?? env.MAVIS_DATA_DIR, p.join(home, '.minimax')), 'config.yaml'),
    pi: p.join(overridden(env.PI_CODING_AGENT_DIR, p.join(home, '.pi', 'agent')), 'models.json'),
    piSettings: p.join(overridden(env.PI_CODING_AGENT_DIR, p.join(home, '.pi', 'agent')), 'settings.json'),
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

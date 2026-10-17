import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { guiCliEnvironment } from './cli-runtime.js';
import { claudePlanLabel, type ClaudeSubscriptionSnapshot } from '../shared/claude-subscription.js';
import { parseClaudeUsageResult } from './claude-usage-parser.js';
import { createSubscriptionCache } from './subscription-cache.js';

const CUSTOM_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const;
type ClaudeAuthKind = 'official' | 'not-signed-in' | 'custom-provider';
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function isConfigured(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value !== null && value !== undefined;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** Detect settings that route Claude outside the official Claude.ai subscription. */
export function hasCustomClaudeConfiguration(
  env: Record<string, string | undefined>,
  settingsDocuments: unknown[] = [],
): boolean {
  if (CUSTOM_ENV_KEYS.some((key) => isConfigured(env[key]))) return true;
  for (const document of settingsDocuments) {
    const settings = asRecord(document);
    if (!settings) continue;
    if (isConfigured(settings.apiKeyHelper)) return true;
    const settingsEnv = asRecord(settings.env);
    if (settingsEnv && CUSTOM_ENV_KEYS.some((key) => isConfigured(settingsEnv[key]))) {
      return true;
    }
  }
  return false;
}

/** Map the CLI's safe auth-status output without exposing its credentials. */
export function classifyClaudeAuthStatus(value: unknown): ClaudeAuthKind | null {
  const status = asRecord(value);
  if (!status || typeof status.loggedIn !== 'boolean') return null;
  if (!status.loggedIn) return 'not-signed-in';
  return (status.authMethod === 'oauth_token' || status.authMethod === 'claude.ai') && status.apiProvider === 'firstParty'
    ? 'official'
    : 'custom-provider';
}

export const CLAUDE_USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence'];
interface ReadClaudeSubscriptionOptions {
  /** Retained for IPC compatibility; the app no longer reads Claude credentials. */
  allowCredentialAccess?: boolean;
  forceRefresh?: boolean;
}
export interface ClaudeCommandResult { stdout: string; code: number | null }
class CommandFailure extends Error {
  constructor(readonly kind: 'not-installed' | 'failed' | 'timeout' | 'output-limit') { super(kind); }
}
export function resolveClaudeCommand(home = homedir(), env = process.env): string {
  const override = env.CLAUDE_CLI_PATH?.trim();
  if (override && existsSync(override)) return override;
  const candidates = process.platform === 'win32'
    ? [path.join(env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe'), path.join(env.APPDATA ?? '', 'npm', 'claude.cmd')]
    : [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.bun', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'),
       ...(env.PNPM_HOME ? [path.join(env.PNPM_HOME, 'claude')] : []),
       path.join(home, 'Library', 'pnpm', 'bin', 'claude'), path.join(home, 'Library', 'pnpm', 'claude'), path.join(home, '.local', 'share', 'pnpm', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find(candidate => existsSync(candidate)) ?? 'claude';
}
export function runClaudeCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<ClaudeCommandResult> {
  return new Promise((resolve, reject) => {
    // npm/pnpm .cmd shims require cmd.exe; quote each argument so empty
    // --tools and --setting-sources values survive the Windows shell.
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const launchArgs = shim ? ['/d', '/s', '/c', `"${[command, ...args].map(value => `"${value}"`).join(' ')}"`] : args;
    const child = spawn(shim ? env.ComSpec ?? 'cmd.exe' : command, launchArgs, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      windowsVerbatimArguments: shim,
    });
    let settled = false, stdout = '', bytes = 0;
    const finish = (error?: CommandFailure, code: number | null = null) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) { child.kill(); reject(error); } else resolve({ stdout, code });
    };
    const timeout = setTimeout(() => finish(new CommandFailure('timeout')), timeoutMs);
    child.once('error', error => finish(new CommandFailure((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'failed')));
    child.once('close', code => finish(undefined, code));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) finish(new CommandFailure('output-limit'));
      else stdout += chunk;
    });
  });
}
function unavailable(status: ClaudeSubscriptionSnapshot['status'], message: string, hasAccount = false, planLabel: string | null = null): ClaudeSubscriptionSnapshot {
  return { status, message, hasAccount, planLabel, fiveHour: null, sevenDay: null, fetchedAt: null, stale: false };
}
export function createClaudeSubscriptionReader(deps: {
  auth: () => Promise<ClaudeCommandResult>;
  usage: () => Promise<ClaudeCommandResult>;
  custom: () => Promise<boolean>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = createSubscriptionCache<ClaudeSubscriptionSnapshot>(now);
  let pending: Promise<ClaudeSubscriptionSnapshot> | null = null;
  let hadAccount = false;
  return (options: ReadClaudeSubscriptionOptions = {}): Promise<ClaudeSubscriptionSnapshot> => {
    if (pending) return pending;
    pending = (async () => {
      if (await deps.custom()) { hadAccount = false; return cache('custom', async () => unavailable('custom-provider', '自定义模型无法获取配额')); }
      let auth: Record<string, unknown> | null;
      try { auth = asRecord(JSON.parse((await deps.auth()).stdout)); }
      catch (error) {
        if (error instanceof CommandFailure && error.kind === 'not-installed') {
          hadAccount = false;
          return cache('missing', async () => unavailable('not-installed', '未检测到本机 Claude Code CLI'));
        }
        return unavailable('temporarily-unavailable', '暂时无法确认 Claude Code 登录状态', hadAccount);
      }
      const kind = classifyClaudeAuthStatus(auth);
      if (kind === 'not-signed-in') { hadAccount = false; return cache('signed-out', async () => unavailable('not-signed-in', '请先登录 Claude Code')); }
      if (kind === 'custom-provider') { hadAccount = false; return cache('custom', async () => unavailable('custom-provider', '自定义模型无法获取配额')); }
      if (kind !== 'official') return unavailable('temporarily-unavailable', '暂时无法确认 Claude Code 登录状态', hadAccount);
      hadAccount = true;
      const planLabel = claudePlanLabel(auth?.subscriptionType);
      // Without identity do not reuse a success across potentially different accounts.
      const key = typeof auth?.email === 'string' && auth.email ? JSON.stringify([auth.email, auth.orgId, auth.organizationId, planLabel]) : `unknown-${now()}`;
      return cache(key, async () => {
        const fail = (status: ClaudeSubscriptionSnapshot['status'], message: string) => unavailable(status, message, true, planLabel);
        try {
          const output = await deps.usage();
          const parsed = parseClaudeUsageResult(output.stdout, new Date(now()));
          if (parsed.denied) return fail('expired', 'Claude 登录或额度访问受限，请检查 Claude Code 登录状态');
          if (output.code !== 0 || parsed.isError) return fail('temporarily-unavailable', 'Claude /usage 读取失败，请稍后重试');
          if (!parsed.fiveHour && !parsed.sevenDay) return fail('temporarily-unavailable', 'Claude /usage 暂未返回可用额度');
          return { status: 'ready', hasAccount: true, planLabel, fiveHour: parsed.fiveHour, sevenDay: parsed.sevenDay, fetchedAt: Math.floor(now() / 1000), stale: false, message: null };
        } catch { return fail('temporarily-unavailable', 'Claude /usage 读取超时或启动失败，请稍后重试'); }
      }, options.forceRefresh);
    })();
    const current = pending;
    void current.finally(() => { if (pending === current) pending = null; }).catch(() => {});
    return current;
  };
}
function configDir(): string {
  const value = process.env.CLAUDE_CONFIG_DIR?.trim();
  return !value ? path.join(homedir(), '.claude') : value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : path.resolve(value);
}
export function claudeUsageEnvironment(): NodeJS.ProcessEnv {
  return { ...guiCliEnvironment(), DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' };
}
export const readClaudeSubscription = createClaudeSubscriptionReader({
  custom: async () => {
    const settings = await Promise.all(['settings.json', 'settings.local.json'].map(async name => {
      try { return JSON.parse(await readFile(path.join(configDir(), name), 'utf8')); } catch { return null; }
    }));
    return hasCustomClaudeConfiguration(process.env, settings);
  },
  auth: () => runClaudeCommand(resolveClaudeCommand(), ['auth', 'status', '--json'], homedir(), guiCliEnvironment(), 5_000),
  usage: async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jusage-claude-'));
    try { return await runClaudeCommand(resolveClaudeCommand(), CLAUDE_USAGE_ARGS, directory, claudeUsageEnvironment(), 15_000); }
    finally { await rm(directory, { recursive: true, force: true }); }
  },
});

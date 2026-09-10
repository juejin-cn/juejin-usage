import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  claudePlanLabel,
  mapClaudeUsageWindows,
  type ClaudeSubscriptionSnapshot,
} from '../shared/claude-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1_024;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CUSTOM_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

type ClaudeAuthKind = 'official' | 'not-signed-in' | 'custom-provider';

interface ClaudeOAuthCredentials {
  accessToken: string;
  expiresAt: number | null;
  planLabel: string | null;
}

interface ReadClaudeSubscriptionOptions {
  /** Credential access is allowed only after an explicit renderer action. */
  allowCredentialAccess?: boolean;
  forceRefresh?: boolean;
}

class CommandFailure extends Error {
  constructor(readonly kind: 'not-installed' | 'failed' | 'timeout') {
    super(kind);
  }
}

let lastSuccess: ClaudeSubscriptionSnapshot | null = null;
let requestInFlight: Promise<ClaudeSubscriptionSnapshot> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function unavailable(
  status: Exclude<ClaudeSubscriptionSnapshot['status'], 'ready'>,
  message: string,
  planLabel: string | null = null,
): ClaudeSubscriptionSnapshot {
  return {
    status,
    planLabel,
    fiveHour: null,
    sevenDay: null,
    fetchedAt: null,
    stale: false,
    message,
  };
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
  return status.authMethod === 'oauth_token' && status.apiProvider === 'firstParty'
    ? 'official'
    : 'custom-provider';
}

/** Parse only the OAuth fields needed for the usage request. */
export function parseClaudeCredentials(value: unknown): ClaudeOAuthCredentials | null {
  const root = typeof value === 'string'
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
    : value;
  const oauth = asRecord(asRecord(root)?.claudeAiOauth);
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) {
    return null;
  }
  const rawExpiry = Number(oauth.expiresAt);
  const expiresAt = Number.isFinite(rawExpiry) && rawExpiry > 0
    ? (rawExpiry < 1_000_000_000_000 ? rawExpiry * 1_000 : rawExpiry)
    : null;
  return {
    accessToken: oauth.accessToken,
    expiresAt,
    planLabel: claudePlanLabel(oauth.subscriptionType),
  };
}

function resolveClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return path.join(homedir(), '.claude');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return path.join(homedir(), configured.slice(2));
  return path.resolve(configured);
}

function resolveClaudeCommand(): string {
  const home = homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'claude', 'claude.exe'),
        path.join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        path.join(home, 'Library', 'pnpm', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? 'claude';
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let stdout = '';
    const finish = (error?: CommandFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new CommandFailure('timeout'));
    }, REQUEST_TIMEOUT_MS);
    child.once('error', (error) => {
      finish(new CommandFailure(
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'failed',
      ));
    });
    child.once('exit', (code) => finish(code === 0 ? undefined : new CommandFailure('failed')));
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length >= MAX_COMMAND_OUTPUT_BYTES) return;
      stdout += chunk.toString('utf8').slice(0, MAX_COMMAND_OUTPUT_BYTES - stdout.length);
    });
  });
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output.trim()) as unknown;
  } catch {
    const lines = output.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      try { return JSON.parse(line) as unknown; } catch { /* keep looking */ }
    }
    return null;
  }
}

async function readSettingsDocuments(): Promise<unknown[]> {
  const root = resolveClaudeConfigDir();
  const documents: unknown[] = [];
  for (const fileName of ['settings.json', 'settings.local.json']) {
    try {
      documents.push(JSON.parse(await readFile(path.join(root, fileName), 'utf8')) as unknown);
    } catch {
      // Missing or malformed settings do not grant custom-provider access.
    }
  }
  return documents;
}

async function readClaudeCredentials(): Promise<ClaudeOAuthCredentials | null> {
  try {
    const fileCredentials = parseClaudeCredentials(
      await readFile(path.join(resolveClaudeConfigDir(), '.credentials.json'), 'utf8'),
    );
    if (fileCredentials) return fileCredentials;
  } catch {
    // Claude Code normally uses Keychain on macOS; try it only after user action.
  }
  if (process.platform !== 'darwin') return null;
  const keychainJson = await runCommand('/usr/bin/security', [
    'find-generic-password',
    '-s',
    'Claude Code-credentials',
    '-w',
  ]);
  return parseClaudeCredentials(keychainJson);
}

function staleFallback(
  unavailableMessage: string,
  staleMessage: string = unavailableMessage,
): ClaudeSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', unavailableMessage);
  return { ...lastSuccess, stale: true, message: staleMessage };
}

async function fetchFreshClaudeSubscription(): Promise<ClaudeSubscriptionSnapshot> {
  let authOutput: string;
  try {
    authOutput = await runCommand(resolveClaudeCommand(), ['auth', 'status', '--json']);
  } catch (error) {
    if (error instanceof CommandFailure && error.kind === 'not-installed') {
      return unavailable('not-installed', '未检测到本机 Claude Code CLI');
    }
    return staleFallback('暂时无法确认 Claude Code 登录状态');
  }

  const authKind = classifyClaudeAuthStatus(parseJsonOutput(authOutput));
  if (authKind === 'not-signed-in') {
    return unavailable('not-signed-in', '请先登录 Claude Code');
  }
  if (authKind === 'custom-provider') {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }
  if (authKind !== 'official') {
    return staleFallback('暂时无法确认 Claude Code 登录状态');
  }

  let credentials: ClaudeOAuthCredentials | null;
  try {
    credentials = await readClaudeCredentials();
  } catch {
    return unavailable('access-denied', '未获授权读取 Claude Code 登录信息');
  }
  if (!credentials) {
    return unavailable('not-signed-in', '未找到 Claude Code 官方登录信息');
  }
  if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) {
    return unavailable('expired', 'Claude 登录已过期，请重新登录', credentials.planLabel);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return unavailable('expired', 'Claude 登录已过期，请重新登录', credentials.planLabel);
    }
    if (response.status === 429) {
      return staleFallback(
        'Claude 配额请求过于频繁，请稍后重试',
        'Claude 配额请求过于频繁，显示上次数据',
      );
    }
    if (!response.ok) return staleFallback('暂时无法读取 Claude 订阅配额');
    const windows = mapClaudeUsageWindows(await response.json());
    if (!windows.fiveHour && !windows.sevenDay) {
      return staleFallback('Claude 暂未返回可用的订阅配额');
    }
    const snapshot: ClaudeSubscriptionSnapshot = {
      status: 'ready',
      planLabel: credentials.planLabel,
      ...windows,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback(
      '网络异常，暂时无法读取 Claude 配额',
      '网络异常，显示上次成功读取的 Claude 配额',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function readClaudeSubscription(
  options: ReadClaudeSubscriptionOptions = {},
): Promise<ClaudeSubscriptionSnapshot> {
  const settings = await readSettingsDocuments();
  if (hasCustomClaudeConfiguration(process.env, settings)) {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }

  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) {
    return lastSuccess;
  }
  if (!options.allowCredentialAccess) {
    if (lastSuccess) {
      return cacheAge <= CACHE_TTL_MS
        ? lastSuccess
        : { ...lastSuccess, stale: true, message: '点击刷新 Claude 订阅配额' };
    }
    return unavailable('authorization-required', '点击获取 Claude 订阅配额');
  }
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshClaudeSubscription();
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

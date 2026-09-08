import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mapAntigravityModels,
  type AntigravitySubscriptionSnapshot,
} from '../shared/antigravity-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CLOUD_CODE_URL = 'https://cloudcode-pa.googleapis.com';
const METADATA = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };

interface GoogleCredentials { accessToken: string; expiresAt: number | null; }
let lastSuccess: AntigravitySubscriptionSnapshot | null = null;
let requestInFlight: Promise<AntigravitySubscriptionSnapshot> | null = null;
const execFile = promisify(execFileCallback);

function antigravityHome(): string { return path.join(homedir(), '.gemini'); }

function unavailable(status: Exclude<AntigravitySubscriptionSnapshot['status'], 'ready'>, message: string): AntigravitySubscriptionSnapshot {
  return { status, planLabel: null, limits: [], fetchedAt: null, stale: false, message };
}

function staleFallback(message: string): AntigravitySubscriptionSnapshot {
  return lastSuccess ? { ...lastSuccess, stale: true, message } : unavailable('temporarily-unavailable', message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseGoogleCredentials(value: unknown): GoogleCredentials | null {
  const root = asRecord(value);
  const accessToken = typeof root?.access_token === 'string' ? root.access_token.trim() : '';
  const rawExpiry = Number(root?.expiry_date ?? root?.expires_at);
  return accessToken ? {
    accessToken,
    expiresAt: Number.isFinite(rawExpiry) && rawExpiry > 0
      ? (rawExpiry < 10_000_000_000 ? rawExpiry * 1_000 : rawExpiry)
      : null,
  } : null;
}

async function readGoogleCredentials(): Promise<GoogleCredentials | null> {
  for (const filename of ['oauth_creds.json', 'google_accounts.json']) {
    try {
      const credentials = parseGoogleCredentials(JSON.parse(await readFile(path.join(antigravityHome(), filename), 'utf8')));
      if (credentials) return credentials;
    } catch { /* try the next official credential file */ }
  }
  return null;
}

function isInstalled(): boolean {
  const home = antigravityHome();
  return ['antigravity', 'antigravity-cli', 'antigravity-ide'].some((name) => existsSync(path.join(home, name)));
}

export function hasCustomAntigravityConfiguration(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.GOOGLE_API_KEY?.trim() || env.GEMINI_API_KEY?.trim() || env.GOOGLE_GEMINI_BASE_URL?.trim() || env.ANTIGRAVITY_BASE_URL?.trim());
}

async function requestCloudCode(endpoint: string, token: string, body: unknown): Promise<{ status: number; value: unknown }> {
  const response = await fetch(`${CLOUD_CODE_URL}${endpoint}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'antigravity' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, value: response.ok ? await response.json() : null };
}

function projectId(value: unknown): string | null {
  const root = asRecord(value);
  const project = root?.cloudaicompanionProject ?? root?.project ?? root?.projectId;
  if (typeof project === 'string' && project) return project;
  const nested = asRecord(project);
  return typeof nested?.id === 'string' && nested.id ? nested.id : null;
}

function antigravityPlan(value: unknown): string | null {
  const root = asRecord(value);
  const tier = asRecord(root?.currentTier);
  return typeof tier?.name === 'string' && tier.name.trim() ? tier.name.trim() : null;
}

interface LocalLanguageServer { baseUrl: string; csrfToken: string; }

/** Discover the running official language server without logging its ephemeral CSRF token. */
async function findLocalLanguageServer(): Promise<LocalLanguageServer | null> {
  try {
    const { stdout } = await execFile('ps', ['-ax', '-o', 'command='], { timeout: 2_000, maxBuffer: 1_000_000 });
    for (const command of stdout.split('\n')) {
      if (!/language_server/i.test(command) || !/antigravity/i.test(command)) continue;
      const csrfToken = /(?:--csrf_token|--csrf-token|-csrf_token)\s+([^\s]+)/.exec(command)?.[1];
      const port = /(?:--extension_server_port|--https_server_port|-https_server_port)\s+(\d+)/.exec(command)?.[1];
      if (csrfToken && port) return { baseUrl: `http://127.0.0.1:${port}`, csrfToken };
    }
  } catch { /* Cloud Code is the intended fallback when the IDE is not running. */ }
  return null;
}

function localStatusModels(value: unknown): unknown {
  const root = asRecord(value);
  const status = asRecord(root?.userStatus) ?? root;
  const array = Array.isArray(asRecord(status?.cascadeModelConfigData)?.clientModelConfigs)
    ? asRecord(status?.cascadeModelConfigData)?.clientModelConfigs as unknown[]
    : [];
  const models: Record<string, unknown> = {};
  for (const config of array) {
    const item = asRecord(config);
    const alias = asRecord(item?.modelOrAlias);
    const id = typeof alias?.model === 'string' ? alias.model : typeof item?.label === 'string' ? item.label : null;
    if (id) models[id] = { displayName: item?.label, quotaInfo: item?.quotaInfo };
  }
  return { models };
}

function localStatusPlan(value: unknown): string | null {
  const root = asRecord(value);
  const status = asRecord(root?.userStatus) ?? root;
  const planInfo = asRecord(asRecord(status?.planStatus)?.planInfo);
  return typeof planInfo?.planName === 'string' && planInfo.planName.trim() ? planInfo.planName.trim() : null;
}

async function readLocalLanguageServerQuota(): Promise<Pick<AntigravitySubscriptionSnapshot, 'planLabel' | 'limits'> | null> {
  const server = await findLocalLanguageServer();
  if (!server) return null;
  try {
    const response = await fetch(`${server.baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
      method: 'POST',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': server.csrfToken,
      },
      body: JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const value = await response.json();
    const limits = mapAntigravityModels(localStatusModels(value));
    return limits.length ? { planLabel: localStatusPlan(value), limits } : null;
  } catch { return null; }
}

async function fetchFreshAntigravitySubscription(): Promise<AntigravitySubscriptionSnapshot> {
  if (!isInstalled()) return unavailable('not-installed', '未检测到本机 Antigravity');
  if (hasCustomAntigravityConfiguration(process.env)) return unavailable('custom-provider', '自定义模型无法获取配额');
  const credentials = await readGoogleCredentials();
  if (!credentials) return unavailable('not-signed-in', '请先登录 Antigravity');
  if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) return unavailable('expired', 'Antigravity 登录已过期，请重新登录');

  try {
    const local = await readLocalLanguageServerQuota();
    if (local) {
      const snapshot: AntigravitySubscriptionSnapshot = { status: 'ready', ...local, fetchedAt: Math.floor(Date.now() / 1_000), stale: false, message: null };
      lastSuccess = snapshot;
      return snapshot;
    }
    const assist = await requestCloudCode('/v1internal:loadCodeAssist', credentials.accessToken, { metadata: METADATA });
    if (assist.status === 401 || assist.status === 403) return unavailable('expired', 'Antigravity 登录已过期，请重新登录');
    if (assist.status === 429) return staleFallback('Antigravity 配额请求过于频繁，请稍后重试');
    if (assist.status < 200 || assist.status >= 300) return staleFallback('暂时无法读取 Antigravity 订阅配额');
    const models = await requestCloudCode('/v1internal:fetchAvailableModels', credentials.accessToken, projectId(assist.value) ? { project: projectId(assist.value) } : {});
    if (models.status === 401 || models.status === 403) return unavailable('expired', 'Antigravity 登录已过期，请重新登录');
    if (models.status === 429) return staleFallback('Antigravity 配额请求过于频繁，请稍后重试');
    const limits = models.status >= 200 && models.status < 300 ? mapAntigravityModels(models.value) : [];
    if (!limits.length) return staleFallback('Antigravity 暂未返回可用的订阅配额');
    const snapshot: AntigravitySubscriptionSnapshot = { status: 'ready', planLabel: antigravityPlan(assist.value), limits, fetchedAt: Math.floor(Date.now() / 1_000), stale: false, message: null };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('网络异常，暂时无法读取 Antigravity 配额');
  }
}

/** Read-only official Antigravity account quota lookup; no tokens are refreshed or persisted. */
export async function readAntigravitySubscription(options: { forceRefresh?: boolean } = {}): Promise<AntigravitySubscriptionSnapshot> {
  if (hasCustomAntigravityConfiguration(process.env)) return unavailable('custom-provider', '自定义模型无法获取配额');
  const cacheAge = lastSuccess?.fetchedAt ? Date.now() - lastSuccess.fetchedAt * 1_000 : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshAntigravitySubscription();
  try { return await requestInFlight; } finally { requestInFlight = null; }
}

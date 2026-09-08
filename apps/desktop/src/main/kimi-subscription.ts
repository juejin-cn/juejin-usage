import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  mapKimiUsage,
  type KimiSubscriptionSnapshot,
} from '../shared/kimi-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const OFFICIAL_BASE_URLS = new Set([
  'https://api.kimi.com/coding/v1',
  'https://api.kimi.ai/coding/v1',
]);

interface KimiCredentials {
  accessToken: string;
  expiresAt: number | null;
}

let lastSuccess: KimiSubscriptionSnapshot | null = null;
let requestInFlight: Promise<KimiSubscriptionSnapshot> | null = null;

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function kimiCodeHome(): string {
  const configured = process.env.KIMI_CODE_HOME?.trim();
  return configured ? expandHome(configured) : path.join(homedir(), '.kimi-code');
}

function kimiBaseUrl(): string {
  return (process.env.KIMI_CODE_BASE_URL?.trim() || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
}

function unavailable(
  status: Exclude<KimiSubscriptionSnapshot['status'], 'ready'>,
  message: string,
): KimiSubscriptionSnapshot {
  return {
    status,
    planLabel: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string): KimiSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message);
  return { ...lastSuccess, stale: true, message };
}

function parseKimiCredentials(value: unknown): KimiCredentials | null {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const accessToken = typeof root?.access_token === 'string' ? root.access_token.trim() : '';
  if (!accessToken) return null;
  const rawExpiry = Number(root?.expires_at);
  return {
    accessToken,
    expiresAt: Number.isFinite(rawExpiry) && rawExpiry > 0
      ? (rawExpiry < 10_000_000_000 ? rawExpiry * 1_000 : rawExpiry)
      : null,
  };
}

async function readKimiCredentials(): Promise<KimiCredentials | null> {
  try {
    return parseKimiCredentials(
      JSON.parse(await readFile(path.join(kimiCodeHome(), 'credentials', 'kimi-code.json'), 'utf8')),
    );
  } catch {
    return null;
  }
}

async function hasManagedKimiConfiguration(): Promise<boolean> {
  try {
    const config = await readFile(path.join(kimiCodeHome(), 'config.toml'), 'utf8');
    const defaultModel = config.match(/^\s*default_model\s*=\s*"([^"]+)"/m)?.[1];
    if (!defaultModel) return false;
    const escapedModel = defaultModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quotedSection = new RegExp(
      `\\[models\\."${escapedModel}"\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    ).exec(config)?.[1];
    const plainSection = /^[A-Za-z0-9_-]+$/.test(defaultModel)
      ? new RegExp(`\\[models\\.${escapedModel}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(config)?.[1]
      : undefined;
    const provider = (quotedSection ?? plainSection)?.match(/^\s*provider\s*=\s*"([^"]+)"/m)?.[1];
    return provider === 'managed:kimi-code';
  } catch {
    return false;
  }
}

export function hasCustomKimiConfiguration(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = (env.KIMI_CODE_BASE_URL?.trim() || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
  return !OFFICIAL_BASE_URLS.has(baseUrl);
}

async function fetchFreshKimiSubscription(): Promise<KimiSubscriptionSnapshot> {
  const home = kimiCodeHome();
  if (!existsSync(home)) return unavailable('not-installed', '未检测到本机 Kimi Code');
  if (!await hasManagedKimiConfiguration()) {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }

  const credentials = await readKimiCredentials();
  if (!credentials) return unavailable('not-signed-in', '请先登录 Kimi Code');
  if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) {
    return unavailable('expired', 'Kimi Code 登录已过期，请重新登录');
  }

  try {
    const response = await fetch(`${kimiBaseUrl()}/usages`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return unavailable('expired', 'Kimi Code 登录已过期，请重新登录');
    }
    if (response.status === 429) return staleFallback('Kimi Code 配额请求过于频繁，请稍后重试');
    if (!response.ok) return staleFallback('暂时无法读取 Kimi Code 订阅配额');
    const limits = mapKimiUsage(await response.json());
    if (limits.length === 0) return staleFallback('Kimi Code 暂未返回可用的订阅配额');
    const snapshot: KimiSubscriptionSnapshot = {
      status: 'ready',
      planLabel: null,
      limits,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('网络异常，暂时无法读取 Kimi Code 配额');
  }
}

/** Read-only Kimi Code subscription lookup; tokens are never refreshed or persisted. */
export async function readKimiSubscription(
  options: { forceRefresh?: boolean } = {},
): Promise<KimiSubscriptionSnapshot> {
  if (hasCustomKimiConfiguration(process.env)) {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }
  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshKimiSubscription();
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

export { parseKimiCredentials };

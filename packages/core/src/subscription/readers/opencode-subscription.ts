import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  mapOpenCodeUsage,
  type OpenCodeSubscriptionSnapshot,
} from '../shared/opencode-subscription.js';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const OFFICIAL_HOSTS = new Set([
  'https://opencode.ai',
  'https://api.opencode.ai',
]);

interface OpenCodeCredentials {
  token: string;
}

let lastSuccess: OpenCodeSubscriptionSnapshot | null = null;
let requestInFlight: Promise<OpenCodeSubscriptionSnapshot> | null = null;

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function openCodeHome(): string {
  const configured = process.env.OPENCODE_HOME?.trim();
  if (configured) return expandHome(configured);
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'opencode');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode');
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
  return path.join(xdg, 'opencode');
}

function unavailable(
  status: Exclude<OpenCodeSubscriptionSnapshot['status'], 'ready'>,
  message: string,
): OpenCodeSubscriptionSnapshot {
  return {
    status,
    planLabel: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string): OpenCodeSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message);
  return { ...lastSuccess, stale: true, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseOpenCodeCredentials(value: unknown): OpenCodeCredentials | null {
  const root = typeof value === 'string'
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
    : value;
  const record = asRecord(root);
  if (!record) return null;
  // Only the `go` entry is treated as an official OpenCode Go subscription
  // credential. Generic `apiKey`/`token` fields are BYOK and rejected.
  const goEntry = asRecord(record.go);
  if (goEntry) {
    const token = pickToken(goEntry);
    if (token) return { token };
  }
  return null;
}

function pickToken(record: Record<string, unknown>): string | null {
  const token = record.token ?? record.apiKey ?? record.api_key;
  return typeof token === 'string' && token.trim().length > 12 ? token.trim() : null;
}

async function readOpenCodeAuth(): Promise<OpenCodeCredentials | null> {
  const authPath = path.join(openCodeHome(), 'auth.json');
  try {
    const text = await readFile(authPath, 'utf8');
    return parseOpenCodeCredentials(JSON.parse(text));
  } catch {
    return null;
  }
}

export function hasCustomOpenCodeConfiguration(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = env.OPENCODE_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
  if (!baseUrl) return false;
  try {
    return !OFFICIAL_HOSTS.has(new URL(baseUrl).origin);
  } catch {
    return true;
  }
}

async function fetchUsage(token: string): Promise<{ ok: boolean; status: number; value: unknown }> {
  const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    ok: response.ok,
    status: response.status,
    value: response.ok ? await response.json() : null,
  };
}

async function fetchFreshOpenCodeSubscription(): Promise<OpenCodeSubscriptionSnapshot> {
  if (!existsSync(openCodeHome())) {
    return unavailable('not-installed', '未检测到本机 OpenCode');
  }
  const credentials = await readOpenCodeAuth();
  if (!credentials) return unavailable('not-signed-in', '请先登录 OpenCode Go');

  try {
    const response = await fetchUsage(credentials.token);
    if (response.status === 401 || response.status === 403) {
      return unavailable('expired', 'OpenCode Go 登录已过期，请重新登录');
    }
    if (response.status === 429) {
      return staleFallback('OpenCode Go 配额请求过于频繁，请稍后重试');
    }
    if (response.status >= 500) {
      return staleFallback('OpenCode Go 配额服务暂时不可用，请稍后重试');
    }
    if (!response.ok || response.status >= 400) {
      return staleFallback('暂时无法读取 OpenCode Go 订阅配额');
    }
    const mapped = mapOpenCodeUsage(response.value);
    if (mapped.limits.length === 0) {
      return staleFallback('OpenCode Go 暂未返回可用的订阅配额');
    }
    const snapshot: OpenCodeSubscriptionSnapshot = {
      status: 'ready',
      planLabel: mapped.planLabel,
      limits: mapped.limits,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('网络异常，暂时无法读取 OpenCode Go 配额');
  }
}

/** Read-only OpenCode Go subscription lookup; Zen pay-as-you-go is excluded. */
export async function readOpenCodeSubscription(
  options: { forceRefresh?: boolean } = {},
): Promise<OpenCodeSubscriptionSnapshot> {
  if (hasCustomOpenCodeConfiguration(process.env)) {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }
  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshOpenCodeSubscription();
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

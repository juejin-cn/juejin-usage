import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  mapMiniMaxAccountQuota,
  mapMiniMaxQuota,
  miniMaxResponseAuthFailed,
  type MiniMaxSubscriptionSnapshot,
} from '../shared/minimax-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

const OFFICIAL_GLOBAL_ORIGIN = 'https://api.minimax.io';
const OFFICIAL_MAINLAND_ORIGIN = 'https://api.minimaxi.com';
// mcode's Token Plan tier and 5h/weekly windows live on the agent host and are
// authenticated with the OAuth login token, not an API key.
const AGENT_API_ORIGINS = {
  global: 'https://agent.minimax.io',
  mainland: 'https://agent.minimax.cn',
} as const;

interface MiniMaxCredentials {
  token: string;
  region: 'global' | 'mainland';
  kind: 'oauth' | 'api-key';
}

let lastSuccess: MiniMaxSubscriptionSnapshot | null = null;
let requestInFlight: Promise<MiniMaxSubscriptionSnapshot> | null = null;

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

/**
 * mcode 3.x keeps everything under `~/.minimax` (`MINIMAX_DATA_DIR` overrides);
 * `~/.minimax-code` is a legacy layout some Coding Plan setups still use.
 */
function minimaxDataHomes(): string[] {
  const homes: string[] = [];
  for (const value of [process.env.MINIMAX_CODE_HOME, process.env.MINIMAX_DATA_DIR, process.env.MAVIS_DATA_DIR]) {
    const trimmed = value?.trim();
    if (trimmed) homes.push(expandHome(trimmed));
  }
  homes.push(path.join(homedir(), '.minimax'), path.join(homedir(), '.minimax-code'));
  return [...new Set(homes)];
}

function openCodeHomeCandidates(): string[] {
  const configured = process.env.OPENCODE_HOME?.trim();
  if (configured) return [expandHome(configured)];
  if (process.platform === 'darwin') {
    return [
      path.join(homedir(), 'Library', 'Application Support', 'opencode'),
      path.join(homedir(), '.local', 'share', 'opencode'),
    ];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming');
    return [path.join(appData, 'opencode')];
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
  return [path.join(xdg, 'opencode')];
}

function unavailable(
  status: Exclude<MiniMaxSubscriptionSnapshot['status'], 'ready'>,
  message: string,
): MiniMaxSubscriptionSnapshot {
  return {
    status,
    planLabel: null,
    region: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string): MiniMaxSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message);
  return { ...lastSuccess, stale: true, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseMiniMaxCredentials(value: unknown): { token: string; region: 'global' | 'mainland' } | null {
  if (typeof value === 'string') {
    const token = value.trim();
    return token.startsWith('sk-cp-') && token.length > 12
      ? { token, region: detectRegion(token) }
      : null;
  }
  const root = asRecord(value);
  if (!root) return null;
  const candidates = [
    root.api_key,
    root.apiKey,
    root.token,
    root.coding_plan_key,
    root.codingPlanKey,
    asRecord(root.auth)?.token,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().startsWith('sk-cp-') && candidate.trim().length > 12) {
      const token = candidate.trim();
      return { token, region: detectRegion(token) };
    }
  }
  return null;
}

function detectRegion(token: string): 'global' | 'mainland' {
  if (token.includes('cn') || token.includes('CN')) return 'mainland';
  return 'global';
}

function detectRegionName(value: string): 'global' | 'mainland' {
  const normalized = value.trim().toLowerCase();
  return normalized === 'cn' || normalized === 'mainland' || normalized === 'zh'
    ? 'mainland'
    : 'global';
}

async function readLocalCredentials(
  homes: string[] = minimaxDataHomes(),
): Promise<MiniMaxCredentials | null> {
  for (const home of homes) {
    for (const name of ['credentials.json', 'auth.json', 'config.json']) {
      let text: string | null = null;
      try {
        text = await readFile(path.join(home, name), 'utf8');
      } catch {
        continue;
      }
      if (text === null) continue;
      try {
        const credentials = parseMiniMaxCredentials(JSON.parse(text));
        if (credentials) return { ...credentials, kind: 'api-key' };
      } catch {
        const credentials = parseMiniMaxCredentials(text);
        if (credentials) return { ...credentials, kind: 'api-key' };
      }
    }
  }
  return null;
}

/**
 * Desktop mcode 3.x stores its OAuth login under
 * `auth/<env>/<region>/<client>/auth.json`; each record carries an
 * `accessToken` (the `mmoat_` bearer the account API accepts).
 */
function readMcodeOAuthCredentials(
  homes: string[] = minimaxDataHomes(),
): MiniMaxCredentials | null {
  for (const home of homes) {
    const authRoot = path.join(home, 'auth');
    let envs: string[] = [];
    try {
      envs = readdirSync(authRoot);
    } catch {
      continue;
    }
    for (const envName of envs) {
      let regions: string[] = [];
      try {
        regions = readdirSync(path.join(authRoot, envName));
      } catch {
        continue;
      }
      for (const regionName of regions) {
        let clients: string[] = [];
        try {
          clients = readdirSync(path.join(authRoot, envName, regionName));
        } catch {
          continue;
        }
        for (const client of clients) {
          try {
            const root = asRecord(JSON.parse(readFileSync(
              path.join(authRoot, envName, regionName, client, 'auth.json'),
              'utf8',
            )));
            const records = asRecord(root?.records);
            if (!records) continue;
            for (const entry of Object.values(records)) {
              const item = asRecord(entry);
              const token = typeof item?.accessToken === 'string' ? item.accessToken.trim() : '';
              if (token.length > 20) {
                return { token, region: detectRegionName(regionName), kind: 'oauth' };
              }
            }
          } catch {
            // Keep scanning sibling client directories.
          }
        }
      }
    }
  }
  return null;
}

async function readOpenCodeAuth(): Promise<MiniMaxCredentials | null> {
  for (const openCodeHome of openCodeHomeCandidates()) {
    try {
      const text = await readFile(path.join(openCodeHome, 'auth.json'), 'utf8');
      const root = JSON.parse(text) as unknown;
      const record = asRecord(root);
      const minimaxEntry = asRecord(record?.minimax) ?? asRecord(record?.['minimax-code']);
      const credentials = parseMiniMaxCredentials(minimaxEntry);
      if (credentials) return { ...credentials, kind: 'api-key' };
    } catch {
      // Try the next OpenCode data directory.
    }
  }
  return null;
}

export function hasCustomMiniMaxConfiguration(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = (env.MINIMAX_CODE_BASE_URL?.trim() || OFFICIAL_GLOBAL_ORIGIN).replace(/\/+$/, '');
  return baseUrl !== OFFICIAL_GLOBAL_ORIGIN && baseUrl !== OFFICIAL_MAINLAND_ORIGIN;
}

function originForRegion(region: 'global' | 'mainland'): string {
  return region === 'mainland' ? OFFICIAL_MAINLAND_ORIGIN : OFFICIAL_GLOBAL_ORIGIN;
}

async function fetchJson(
  url: string,
  token: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ ok: boolean; status: number; value: unknown }> {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    ok: response.ok,
    status: response.status,
    value: response.ok ? await response.json() : null,
  };
}

function responseAuthFailed(response: { status: number; value: unknown }): boolean {
  return response.status === 401
    || response.status === 403
    || miniMaxResponseAuthFailed(response.value);
}

async function fetchFreshMiniMaxSubscription(): Promise<MiniMaxSubscriptionSnapshot> {
  const homes = minimaxDataHomes();
  const installed = homes.some((home) => existsSync(home));
  const credentials = (await readLocalCredentials(homes))
    ?? readMcodeOAuthCredentials(homes)
    ?? (await readOpenCodeAuth());
  if (!credentials) {
    return installed
      ? unavailable('not-signed-in', '请先登录 MiniMax Code')
      : unavailable('not-installed', '未检测到本机 MiniMax Code');
  }
  return credentials.kind === 'oauth'
    ? fetchAccountQuota(credentials)
    : fetchQuota(credentials);
}

/** Coding Plan `sk-cp-` keys use the open-platform `token_plan/remains` quota. */
async function fetchQuota(credentials: MiniMaxCredentials): Promise<MiniMaxSubscriptionSnapshot> {
  const origin = originForRegion(credentials.region);
  try {
    const response = await fetchJson(`${origin}/v1/token_plan/remains`, credentials.token);
    if (responseAuthFailed(response)) {
      return unavailable('expired', 'MiniMax Code 登录已过期，请重新登录');
    }
    if (response.status === 429) {
      return staleFallback('MiniMax Code 配额请求过于频繁，请稍后重试');
    }
    if (response.status >= 500) {
      return staleFallback('MiniMax 配额服务暂时不可用，请稍后重试');
    }
    if (!response.ok || response.status >= 400) {
      return staleFallback('暂时无法读取 MiniMax Code 订阅配额');
    }
    const mapped = mapMiniMaxQuota(response.value);
    if (mapped.limits.length === 0) {
      return staleFallback('MiniMax Code 暂未返回可用的订阅配额');
    }
    const snapshot: MiniMaxSubscriptionSnapshot = {
      status: 'ready',
      planLabel: mapped.planLabel,
      region: credentials.region,
      limits: mapped.limits,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('网络异常，暂时无法读取 MiniMax Code 配额');
  }
}

/**
 * mcode OAuth logins query the account API instead: membership (Token Plan
 * tier) on the agent host plus `token_plan/remains_percent` for the windows.
 */
async function fetchAccountQuota(credentials: MiniMaxCredentials): Promise<MiniMaxSubscriptionSnapshot> {
  const apiOrigin = originForRegion(credentials.region);
  const agentOrigin = AGENT_API_ORIGINS[credentials.region];
  try {
    const [remains, membership] = await Promise.all([
      fetchJson(`${apiOrigin}/backend/account/token_plan/remains_percent`, credentials.token),
      fetchJson(`${agentOrigin}/matrix/api/v1/commerce/get_membership_info`, credentials.token, 'POST'),
    ]);
    if (responseAuthFailed(remains) && responseAuthFailed(membership)) {
      return unavailable('expired', 'MiniMax Code 登录已过期，请重新登录');
    }
    if (remains.status === 429 || membership.status === 429) {
      return staleFallback('MiniMax Code 配额请求过于频繁，请稍后重试');
    }
    if (remains.status >= 500 || membership.status >= 500) {
      return staleFallback('MiniMax 配额服务暂时不可用，请稍后重试');
    }

    const memberRecord = asRecord(membership.value);
    const memberBase = asRecord(memberRecord?.base_resp);
    const memberOk = membership.status >= 200 && membership.status < 300
      && (!memberBase || Number(memberBase.status_code) === 0);
    if (memberOk && memberRecord?.has_token_plan === false) {
      return unavailable('unsupported-account', '当前 MiniMax 账号未开通 Token Plan 订阅');
    }
    const remainsOk = remains.status >= 200 && remains.status < 300;
    const mapped = mapMiniMaxAccountQuota(
      memberOk ? membership.value : null,
      remainsOk ? remains.value : null,
    );
    if (mapped.limits.length === 0) {
      return staleFallback('MiniMax Code 暂未返回可用的订阅配额');
    }
    const snapshot: MiniMaxSubscriptionSnapshot = {
      status: 'ready',
      planLabel: mapped.planLabel,
      region: credentials.region,
      limits: mapped.limits,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('网络异常，暂时无法读取 MiniMax Code 配额');
  }
}

/** Read-only MiniMax Code subscription lookup; BYOK and pay-as-you-go keys are filtered. */
export async function readMiniMaxSubscription(
  options: { forceRefresh?: boolean } = {},
): Promise<MiniMaxSubscriptionSnapshot> {
  if (hasCustomMiniMaxConfiguration(process.env)) {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }
  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshMiniMaxSubscription();
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

export {
  readMcodeOAuthCredentials as readMiniMaxMcodeCredentials,
  readOpenCodeAuth as readMiniMaxOpenCodeAuth,
  readLocalCredentials as readMiniMaxLocalCredentials,
};

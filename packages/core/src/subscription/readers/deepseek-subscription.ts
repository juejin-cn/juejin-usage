import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import {
  mapDeepSeekBalance,
  type DeepSeekSubscriptionSnapshot,
} from '../shared/deepseek-subscription.js';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const OFFICIAL_HOSTS = new Set(['https://api.deepseek.com']);

interface DeepSeekCredentials {
  token: string;
  kind?: 'harness-account' | 'harness-api-key';
}

let lastSuccess: DeepSeekSubscriptionSnapshot | null = null;
let requestInFlight: Promise<DeepSeekSubscriptionSnapshot> | null = null;
let activeCredentialKey: string | null = null;

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function deepseekHome(): string {
  const configured = process.env.DEEPSEEK_HOME?.trim();
  return configured ? expandHome(configured) : path.join(homedir(), '.deepseek');
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
  status: Exclude<DeepSeekSubscriptionSnapshot['status'], 'ready'>,
  message: string,
): DeepSeekSubscriptionSnapshot {
  return {
    status,
    planLabel: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string): DeepSeekSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message);
  return { ...lastSuccess, stale: true, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseDeepSeekCredentials(value: unknown): DeepSeekCredentials | null {
  const root = typeof value === 'string'
    ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
    : value;
  const record = asRecord(root);
  if (!record) return null;
  const candidates = [
    record.api_key,
    record.apiKey,
    record.token,
    record.access_token,
    record.accessToken,
    asRecord(record.auth)?.token,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 12) {
      return { token: candidate.trim() };
    }
  }
  return null;
}

/** Read Harness's documented versioned store without modifying its grant. */
export function parseDeepSeekHarnessCredentials(text: string): DeepSeekCredentials | null {
  try {
    const root = asRecord(parseYaml(text, { maxAliasCount: 0 }));
    if (root?.version !== 1) return null;
    const record = asRecord(asRecord(root.records)?.['deepseek-account-platform/default']);
    const payload = asRecord(record?.payload);
    if (record?.kind === 'grant' && payload?.version === 1
      && payload.issuer === 'https://platform.deepseek.com'
      && typeof payload.token === 'string' && /^[\x21-\x7e]+$/.test(payload.token)) {
      return { token: payload.token, kind: 'harness-account' };
    }
    const apiKey = asRecord(root.refs)?.DEEPSEEK_API_KEY;
    return typeof apiKey === 'string' && apiKey.trim().length > 12
      ? { token: apiKey.trim(), kind: 'harness-api-key' } : null;
  } catch { return null; }
}

async function readHarnessCredentials(): Promise<DeepSeekCredentials | null> {
  const home = process.env.DSH_HOME?.trim();
  try {
    return parseDeepSeekHarnessCredentials(await readFile(
      path.join(home ? expandHome(home) : path.join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8',
    ));
  } catch { return null; }
}

async function readLocalCredentials(): Promise<DeepSeekCredentials | null> {
  const home = deepseekHome();
  const candidates = [
    path.join(home, 'credentials.json'),
    path.join(home, 'auth.json'),
  ];
  for (const candidate of candidates) {
    let text: string | null = null;
    try {
      text = await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    if (text === null) continue;
    try {
      const credentials = parseDeepSeekCredentials(JSON.parse(text));
      if (credentials) return credentials;
    } catch {
      const credentials = parseDeepSeekCredentials(text);
      if (credentials) return credentials;
    }
  }
  return null;
}

async function readOpenCodeAuth(): Promise<DeepSeekCredentials | null> {
  const authPath = path.join(openCodeHome(), 'auth.json');
  try {
    const text = await readFile(authPath, 'utf8');
    const root = JSON.parse(text) as unknown;
    const record = asRecord(root);
    return parseDeepSeekCredentials(record?.deepseek ?? record?.['deepseek-code']);
  } catch {
    return null;
  }
}

export function hasCustomDeepSeekConfiguration(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = env.DEEPSEEK_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
  return Boolean(baseUrl) && !OFFICIAL_HOSTS.has(baseUrl);
}

export async function fetchDeepSeekBalance(credentials: DeepSeekCredentials, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; status: number; value: unknown }> {
  const account = credentials.kind === 'harness-account';
  const response = await fetcher(account
    ? 'https://platform.deepseek.com/api/v0/users/get_user_summary'
    : 'https://api.deepseek.com/user/balance', {
    headers: account
      ? { Accept: 'application/json', 'x-dsh-auth-token': credentials.token }
      : { Accept: 'application/json', Authorization: `Bearer ${credentials.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'error',
  });
  const value: unknown = response.ok ? await response.json() : null;
  if (account && response.ok) {
    const envelope = asRecord(value), data = asRecord(envelope?.data);
    if (envelope?.code === 40003) return { ok: false, status: 401, value: null };
    if (envelope?.code !== 0 || data?.biz_code !== 0) return { ok: false, status: 502, value: null };
    return { ok: true, status: response.status, value: mapHarnessWalletBalance(data.biz_data) };
  }
  return {
    ok: response.ok,
    status: response.status,
    value,
  };
}

/** Convert the account's CNY recharge + bonus wallets to the API balance shape. */
export function mapHarnessWalletBalance(value: unknown): unknown {
  const data = asRecord(value);
  const sum = (wallets: unknown): number | null => {
    if (!Array.isArray(wallets)) return null;
    let total = 0;
    for (const item of wallets) {
      const wallet = asRecord(item);
      if (wallet?.currency !== 'CNY') continue;
      const raw = wallet.balance;
      if ((typeof raw !== 'string' || !raw.trim()) && typeof raw !== 'number') return null;
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) return null;
      total += amount;
    }
    return Number.isFinite(total) ? total : null;
  };
  const toppedUp = sum(data?.normal_wallets), granted = sum(data?.bonus_wallets);
  if (toppedUp === null || granted === null) return null;
  return { balance_infos: [{ currency: 'CNY', total_balance: toppedUp + granted, granted_balance: granted, topped_up_balance: toppedUp }] };
}

async function fetchFreshDeepSeekSubscription(forceRefresh = false): Promise<DeepSeekSubscriptionSnapshot> {
  const harness = await readHarnessCredentials();
  if (harness) return queryBalance(harness, forceRefresh);
  if (!existsSync(deepseekHome())) {
    const openCodeCredentials = await readOpenCodeAuth();
    if (!openCodeCredentials) {
      lastSuccess = null;
      return unavailable('not-installed', '未检测到本机 DeepSeek');
    }
    return queryBalance(openCodeCredentials, forceRefresh);
  }

  const localCredentials = await readLocalCredentials();
  const credentials = localCredentials ?? (await readOpenCodeAuth());
  if (!credentials) {
    lastSuccess = null;
    return unavailable('not-signed-in', '请先登录 DeepSeek');
  }
  return queryBalance(credentials, forceRefresh);
}

async function queryBalance(credentials: DeepSeekCredentials, forceRefresh = false): Promise<DeepSeekSubscriptionSnapshot> {
  const credentialKey = createHash('sha256').update(`${credentials.kind ?? 'api-key'}:${credentials.token}`).digest('hex');
  if (credentialKey !== activeCredentialKey) {
    activeCredentialKey = credentialKey;
    lastSuccess = null;
  }
  if (!forceRefresh && lastSuccess?.fetchedAt && Date.now() - lastSuccess.fetchedAt * 1_000 <= CACHE_TTL_MS) return lastSuccess;
  try {
    const response = await fetchDeepSeekBalance(credentials);
    if (response.status === 401 || response.status === 403) {
      lastSuccess = null;
      return unavailable('expired', 'DeepSeek 登录已过期，请重新登录');
    }
    if (response.status === 429) {
      return staleFallback('DeepSeek 余额请求过于频繁，请稍后重试');
    }
    if (response.status >= 500) {
      return staleFallback('DeepSeek 余额服务暂时不可用，请稍后重试');
    }
    if (!response.ok || response.status >= 400) {
      return staleFallback('暂时无法读取 DeepSeek 余额');
    }
    const mapped = mapDeepSeekBalance(response.value);
    if (mapped.limits.length === 0 || mapped.limits[0]!.total === null) {
      return staleFallback('DeepSeek 暂未返回可用的账户余额');
    }
    const snapshot: DeepSeekSubscriptionSnapshot = {
      status: 'ready',
      planLabel: mapped.planLabel,
      limits: mapped.limits,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
      source: credentials.kind === 'harness-account' ? 'DeepSeek Harness 账号余额' : 'DeepSeek API 余额',
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('网络异常，暂时无法读取 DeepSeek 余额');
  }
}

/** Read-only DeepSeek account balance lookup; non-official base URLs are filtered. */
export async function readDeepSeekSubscription(
  options: { forceRefresh?: boolean } = {},
): Promise<DeepSeekSubscriptionSnapshot> {
  if (hasCustomDeepSeekConfiguration(process.env)) {
    return unavailable('custom-provider', '自定义模型无法获取余额');
  }
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshDeepSeekSubscription(options.forceRefresh);
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

export { readLocalCredentials as readDeepSeekLocalCredentials, readOpenCodeAuth as readDeepSeekOpenCodeAuth };

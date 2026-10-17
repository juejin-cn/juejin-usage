import { existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { mapQoderQuota, type QoderSubscriptionSnapshot } from '../shared/qoder-subscription.js';
import { readQoderAppAuth } from './qoder-app-auth.js';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const QODER_API_URL = 'https://openapi.qoder.sh';

interface QoderCredentials { token: string; }
export interface QoderAccount extends QoderCredentials {
  source: 'app' | 'cli';
  identity: string;
  expiresAt: number | null;
  validateIdentity?: () => Promise<boolean>;
}
interface ReadOptions { forceRefresh?: boolean; }

function qoderHome(): string { return path.join(homedir(), '.qoder'); }
function unavailable(status: Exclude<QoderSubscriptionSnapshot['status'], 'ready'>, message: string): QoderSubscriptionSnapshot {
  return { status, planLabel: null, limits: [], fetchedAt: null, stale: false, message };
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Extracts only account-session bearer fields from Qoder's official local auth state. */
export function parseQoderCredentials(value: unknown): QoderCredentials | null {
  const root = asRecord(value);
  if (!root) return null;
  for (const key of ['security_oauth_token', 'access_token', 'accessToken', 'bearerToken', 'token', 'jwtToken']) {
    if (typeof root[key] === 'string' && root[key].trim().length > 20 && !/[\r\n]/.test(root[key])) return { token: root[key].trim() };
  }
  for (const key of ['user', 'auth', 'session', 'data']) {
    const nested = parseQoderCredentials(root[key]);
    if (nested) return nested;
  }
  return null;
}

export function parseQoderAppLoginStatus(value: unknown): boolean | null {
  const root = asRecord(value);
  if (!root) return null;
  const loggedIn = root.logged_in ?? root.loggedIn;
  return typeof loggedIn === 'boolean' ? loggedIn : null;
}

async function readQoderAppLoginStatus(home = qoderHome()): Promise<boolean | null> {
  try {
    const content = await readFile(path.join(home, '.qoder-app-status.json'), 'utf8');
    return parseQoderAppLoginStatus(JSON.parse(content));
  }
  catch { return null; }
}

async function readQoderCredentials(home = qoderHome()): Promise<QoderCredentials | null> {
  try {
    const content = await readFile(path.join(home, '.auth', 'user'), 'utf8');
    try { return parseQoderCredentials(JSON.parse(content)); } catch { return parseQoderCredentials(content); }
  } catch { return null; }
}

interface CachedQoderQuota { value: unknown; fetchedAt: number; }

/**
 * Recent official CLI logs contain the normalized quota response but never need
 * a token to read. This is the safe fallback for Qoder's encrypted auth file.
 */
async function readCachedQoderQuota(home = qoderHome()): Promise<CachedQoderQuota | null> {
  const runsDirectory = path.join(home, 'logs', 'runs');
  if (!existsSync(runsDirectory)) return null;
  let latest: CachedQoderQuota | null = null;
  try {
    for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const logPath = path.join(runsDirectory, entry.name, 'qodercli.log');
      if (!existsSync(logPath) || statSync(logPath).size > 2_000_000) continue;
      const content = await readFile(logPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const marker = '/api/v2/quota/usage response:';
        const index = line.indexOf(marker);
        if (index < 0) continue;
        try {
          const value = JSON.parse(line.slice(index + marker.length).trim());
          const fetchedAt = Math.floor(statSync(logPath).mtimeMs / 1_000);
          if (!latest || fetchedAt > latest.fetchedAt) latest = { value, fetchedAt };
        } catch { /* Ignore malformed or partially written log lines. */ }
      }
    }
  } catch { return latest; }
  return latest;
}
export async function loadQoderAccount(options: ReadOptions & {
  decryptString?: (value: Buffer) => string;
  home?: string;
  readAppAuth?: typeof readQoderAppAuth;
} = {}): Promise<QoderAccount | QoderSubscriptionSnapshot> {
  const home = options.home ?? qoderHome();
  if (!existsSync(home)) return unavailable('not-installed', '未检测到本机 Qoder');
  const app = await (options.readAppAuth ?? readQoderAppAuth)({ allowKeychainPrompt: options.forceRefresh === true, decryptString: options.decryptString });
  if (app?.kind === 'account') return { ...app, source: 'app' };
  if (app?.kind === 'unavailable') return unavailable('temporarily-unavailable', app.message);
  const credentials = await readQoderCredentials(home);
  if (credentials) {
    return {
      ...credentials, source: 'cli', expiresAt: null,
      identity: `cli:${createHash('sha256').update(credentials.token).digest('hex')}`,
      validateIdentity: async () => (await readQoderCredentials(home))?.token === credentials.token
        && await readQoderAppLoginStatus(home) !== true,
    };
  }
  if (app?.kind === 'signed-out') return unavailable('not-signed-in', '请先登录 Qoder');
  // A CLI cache has no verifiable App identity; never use it for a known App account.
  if (await readQoderAppLoginStatus(home)) return unavailable('temporarily-unavailable', '已登录 Qoder，但暂时无法读取订阅额度');
  const cached = await readCachedQoderQuota(home);
  const mapped = cached ? mapQoderQuota(cached.value, null) : null;
  if (cached && mapped?.limits.length) return {
    status: 'ready', ...mapped, fetchedAt: cached.fetchedAt, stale: true,
    message: '使用 Qoder CLI 最近同步的额度',
  };
  return unavailable('not-signed-in', '请先登录 Qoder');
}

/** Keep credentials in main and cache only quota belonging to the current local account. */
export function createQoderSubscriptionReader(
  loadAccount: (options: ReadOptions) => Promise<QoderAccount | QoderSubscriptionSnapshot> = loadQoderAccount,
  fetchImpl: typeof fetch = fetch,
) {
  let lastSuccess: QoderSubscriptionSnapshot | null = null;
  let identity: string | null = null;
  let generation = 0;
  let pending: Promise<QoderSubscriptionSnapshot> | null = null;
  function clear() { lastSuccess = null; pending = null; identity = null; generation++; }
  return async (options: ReadOptions = {}): Promise<QoderSubscriptionSnapshot> => {
    let account: QoderAccount | QoderSubscriptionSnapshot;
    try { account = await loadAccount(options); }
    catch { clear(); return unavailable('temporarily-unavailable', '暂时无法读取 Qoder 登录信息'); }
    if (!('token' in account)) { clear(); return account; }
    if (identity !== account.identity) { clear(); identity = account.identity; }
    if (account.expiresAt !== null && account.expiresAt <= Date.now()) {
      clear(); return unavailable('expired', 'Qoder 登录已过期，请打开 Qoder 更新登录状态');
    }
    if (pending) return pending;
    if (!options.forceRefresh && lastSuccess?.fetchedAt && !lastSuccess.stale
      && Date.now() - lastSuccess.fetchedAt * 1_000 < CACHE_TTL_MS) return lastSuccess;
    const currentGeneration = generation;
    const selected = account;
    const changed = () => unavailable('temporarily-unavailable', 'Qoder 账号已变化，请刷新额度');
    const task = (async () => {
      let snapshot: QoderSubscriptionSnapshot;
      try {
        const request = async (pathname: string) => {
          const response = await fetchImpl(`${QODER_API_URL}${pathname}`, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${selected.token}`,
              ...(selected.source === 'app' ? { 'Cosy-ClientType': '10', 'User-Agent': 'Qoder' } : {}) },
            redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          return { status: response.status, value: response.ok ? await response.json() : null };
        };
        // A failed optional plan lookup must not discard a successful quota response.
        const [plan, quota] = await Promise.all([
          request('/api/v2/user/plan').catch(() => null),
          request(selected.source === 'app' ? '/sash/api/v2/me/usage' : '/api/v2/quota/usage'),
        ]);
        if (quota.status === 401 || quota.status === 403) snapshot = unavailable('expired', 'Qoder 登录已过期，请重新登录');
        else if (quota.status === 429) snapshot = unavailable('temporarily-unavailable', 'Qoder 配额请求过于频繁，请稍后重试');
        else {
          const mapped = quota.status >= 200 && quota.status < 300 ? mapQoderQuota(quota.value, plan?.value) : null;
          snapshot = mapped?.limits.length
            ? { status: 'ready', ...mapped, fetchedAt: Math.floor(Date.now() / 1_000), stale: false, message: null }
            : unavailable('temporarily-unavailable', 'Qoder 暂未返回可用的订阅配额');
        }
      } catch { snapshot = unavailable('temporarily-unavailable', '网络异常，暂时无法读取 Qoder 配额'); }
      if (currentGeneration !== generation) return changed();
      try {
        const valid = selected.validateIdentity ? await selected.validateIdentity()
          : await loadAccount({ forceRefresh: false }).then((current) => 'token' in current && current.identity === selected.identity);
        if (currentGeneration !== generation) return changed();
        if (!valid) { clear(); return changed(); }
      } catch { clear(); return changed(); }
      if (snapshot.status === 'temporarily-unavailable' && lastSuccess) snapshot = { ...lastSuccess, stale: true, message: snapshot.message };
      lastSuccess = snapshot.status === 'ready' ? snapshot : null;
      return snapshot;
    })();
    pending = task;
    try { return await task; }
    finally { if (pending === task) pending = null; }
  };
}

export const readQoderSubscription = createQoderSubscriptionReader();

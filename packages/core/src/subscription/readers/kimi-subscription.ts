import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readKimiDesktopContext, type KimiDesktopContext } from './kimi-desktop-context.js';
import {
  mapKimiDesktopSubscription,
  mapKimiUsage,
  type KimiSubscriptionSnapshot,
} from '../shared/kimi-subscription.js';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const OFFICIAL_BASE_URLS = new Set([
  'https://api.kimi.com/coding/v1',
  'https://api.kimi.ai/coding/v1',
]);
const DESKTOP_ORIGINS = new Set(['https://www.kimi.com', 'https://www.kimi.ai']);

interface KimiCredentials {
  accessToken: string;
  expiresAt: number | null;
}

export interface KimiAccount extends KimiCredentials {
  source: 'desktop' | 'code';
  userId: string;
  origin: string;
  /** Local token metadata is only a stale fallback, never a live quota reading. */
  planLabel: string | null;
  /** The desktop IPC source verifies the current account again before publishing. */
  validateIdentity?: () => Promise<boolean>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeToken(value: unknown): string {
  return typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function kimiCodeHome(env: NodeJS.ProcessEnv): string {
  const configured = env.KIMI_CODE_HOME?.trim();
  return configured ? expandHome(configured) : path.join(homedir(), '.kimi-code');
}

function kimiBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.KIMI_CODE_BASE_URL?.trim() || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
}

function unavailable(
  status: Exclude<KimiSubscriptionSnapshot['status'], 'ready'>,
  message: string,
  source?: KimiAccount['source'],
): KimiSubscriptionSnapshot {
  return { status, ...(source ? { source } : {}), planLabel: null, limits: [], fetchedAt: null, stale: false, message };
}

export function parseKimiCredentials(value: unknown): KimiCredentials | null {
  const root = asRecord(value);
  const accessToken = safeToken(root?.access_token);
  if (!accessToken) return null;
  const rawExpiry = Number(root?.expires_at);
  return {
    accessToken,
    expiresAt: Number.isFinite(rawExpiry) && rawExpiry > 0
      ? (rawExpiry < 10_000_000_000 ? rawExpiry * 1_000 : rawExpiry)
      : null,
  };
}

/** Inspect only the current desktop IPC token; never read a persisted refresh token. */
export function parseKimiDesktopToken(value: unknown, userId: string): (KimiCredentials & Pick<KimiAccount, 'userId' | 'planLabel'>) | null {
  const accessToken = safeToken(value);
  if (!accessToken || !userId) return null;
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    const claims = asRecord(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
    const expiry = claims?.exp;
    if (claims?.sub !== userId || typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) return null;
    const level = asRecord(claims.membership)?.level;
    return { accessToken, userId, expiresAt: expiry * 1_000, planLabel: level === 10 || level === 12 ? 'Free' : null };
  } catch {
    return null;
  }
}

async function readOptionalJson(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function codeConfiguration(home: string): Promise<'managed' | 'custom' | 'missing'> {
  let config: string;
  try {
    config = await readFile(path.join(home, 'config.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  const defaultModel = config.match(/^\s*default_model\s*=\s*"([^"]+)"/m)?.[1];
  if (!defaultModel) return 'missing';
  const escapedModel = defaultModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedSection = new RegExp(`\\[models\\."${escapedModel}"\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(config)?.[1];
  const plainSection = /^[A-Za-z0-9_-]+$/.test(defaultModel)
    ? new RegExp(`\\[models\\.${escapedModel}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(config)?.[1]
    : undefined;
  const provider = (quotedSection ?? plainSection)?.match(/^\s*provider\s*=\s*"([^"]+)"/m)?.[1];
  return provider === 'managed:kimi-code' ? 'managed' : provider ? 'custom' : 'missing';
}

export function hasCustomKimiConfiguration(env: NodeJS.ProcessEnv): boolean {
  return !OFFICIAL_BASE_URLS.has(kimiBaseUrl(env));
}

/** Match the desktop bridge's platform header, including its Linux/web fallback. */
export function kimiDesktopPlatform(platform: NodeJS.Platform): 'mac' | 'windows' | 'web' {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'web';
}

/** Each source resolves its own account without falling back to the other product. */
export async function loadKimiAccount(options: {
  source?: KimiAccount['source'];
  desktopDataDir?: string;
  desktopShareDir?: string;
  codeHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readDesktopContext?: () => Promise<KimiDesktopContext | null>;
} = {}): Promise<KimiAccount | KimiSubscriptionSnapshot> {
  const env = options.env ?? process.env;
  if (options.source === 'code') {
    const home = options.codeHome ?? kimiCodeHome(env);
    if (!existsSync(home)) return unavailable('not-installed', '未检测到本机 Kimi Code', 'code');
    const configuration = await codeConfiguration(home);
    if (hasCustomKimiConfiguration(env) || configuration === 'custom') {
      return unavailable('custom-provider', '自定义模型无法获取配额', 'code');
    }
    const credentials = parseKimiCredentials(await readOptionalJson(path.join(home, 'credentials', 'kimi-code.json')));
    return configuration === 'managed' && credentials
      ? { ...credentials, source: 'code', userId: 'kimi-code', origin: kimiBaseUrl(env), planLabel: null }
      : unavailable('not-signed-in', '请先登录 Kimi Code', 'code');
  }
  let context: KimiDesktopContext | null;
  try {
    context = await (options.readDesktopContext ?? readKimiDesktopContext)();
  } catch {
    return unavailable('temporarily-unavailable', 'Kimi 桌面版账号信息正在同步，请稍后重试', 'desktop');
  }
  if (context) {
    const desktop = parseKimiDesktopToken(context.accessToken, context.userId);
    if (!desktop) return unavailable('not-signed-in', '暂时无法验证 Kimi 桌面版当前账号，请重新登录', 'desktop');
    if (context.region !== 'china' && context.region !== 'overseas') {
      return unavailable('temporarily-unavailable', '暂时无法确定 Kimi 桌面版账号地区', 'desktop');
    }
    return {
      ...desktop, source: 'desktop',
      origin: context.region === 'overseas' ? 'https://www.kimi.ai' : 'https://www.kimi.com',
      validateIdentity: context.validateIdentity,
    };
  }
  // Core is ESM-only; defer it so the standalone Node test build can import this reader.
  const core = options.desktopDataDir && options.desktopShareDir
    ? null : await import('@juejin-opensource/jusage-core');
  const profile = options.desktopDataDir ?? core!.kimiDesktopDataDir();
  const share = options.desktopShareDir ?? core!.kimiDesktopShareDir();
  if (existsSync(profile) || existsSync(share)) {
    const requiresPipe = (options.platform ?? process.platform) === 'win32' && !env.KIMI_WORK_CONTEXT_IPC?.trim();
    return unavailable(
      requiresPipe ? 'temporarily-unavailable' : 'not-signed-in',
      requiresPipe
        ? '暂不支持自动连接 Windows 版 Kimi，请参阅桌面版适配说明'
        : '请打开 Kimi 桌面版以读取当前账号',
      'desktop',
    );
  }
  return unavailable('not-installed', '未检测到本机 Kimi 桌面版', 'desktop');
}

async function fetchKimiCodeSubscription(
  account: KimiAccount,
  fetchImpl: typeof fetch,
  previous: KimiSubscriptionSnapshot | null,
): Promise<KimiSubscriptionSnapshot> {
  const response = await fetchImpl(`${account.origin}/usages`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${account.accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    return unavailable('expired', 'Kimi Code 登录已过期，请重新登录', 'code');
  }
  const limits = response.ok ? mapKimiUsage(await response.json()) : [];
  if (limits.length > 0) {
    return {
      status: 'ready', source: 'code', planLabel: null, limits,
      fetchedAt: Math.floor(Date.now() / 1_000), stale: false, message: null,
    };
  }
  const message = '暂时无法读取 Kimi Code 订阅额度';
  return previous ? { ...previous, stale: true, message }
    : unavailable('temporarily-unavailable', message, 'code');
}

async function fetchKimiSubscription(
  account: KimiAccount,
  fetchImpl: typeof fetch,
  previous: KimiSubscriptionSnapshot | null,
): Promise<KimiSubscriptionSnapshot> {
  if (account.source === 'code') return fetchKimiCodeSubscription(account, fetchImpl, previous);
  const response = await fetchImpl(`${account.origin}/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'X-Language': 'zh-CN',
      'x-msh-platform': kimiDesktopPlatform(process.platform),
      'R-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    return unavailable('expired', 'Kimi 桌面版登录已过期，请重新登录', 'desktop');
  }
  if (!response.ok) throw new Error('Kimi subscription is unavailable');
  const value: unknown = await response.json();
  const mapped = mapKimiDesktopSubscription(value);
  if (!mapped.planLabel && mapped.limits.length === 0) throw new Error('Kimi subscription response has no supported data');
  return {
    status: 'ready', source: account.source, ...mapped,
    fetchedAt: Math.floor(Date.now() / 1_000), stale: false,
    message: mapped.limits.length === 0 ? 'Kimi 桌面版暂未提供可展示的额度' : null,
  };
}

/** Read-only; cache identity includes source, region, account and credential session. */
export function createKimiSubscriptionReader(
  loadAccount: () => Promise<KimiAccount | KimiSubscriptionSnapshot> = loadKimiAccount,
  fetchImpl: typeof fetch = fetch,
) {
  let lastSuccess: KimiSubscriptionSnapshot | null = null;
  let accountKey: string | null = null;
  let generation = 0;
  let requestInFlight: Promise<KimiSubscriptionSnapshot> | null = null;

  function clear(): void {
    lastSuccess = null;
    requestInFlight = null;
    accountKey = null;
    generation++;
  }

  function identity(account: KimiAccount): string {
    return createHash('sha256').update(JSON.stringify([
      account.source, account.origin, account.userId, account.accessToken,
    ])).digest('hex');
  }

  return async (options: { forceRefresh?: boolean } = {}): Promise<KimiSubscriptionSnapshot> => {
    let account: KimiAccount | KimiSubscriptionSnapshot;
    try {
      account = await loadAccount();
    } catch {
      clear();
      return unavailable('temporarily-unavailable', '暂时无法读取 Kimi 本机登录信息');
    }
    if (!('accessToken' in account)) {
      clear();
      return account;
    }
    const key = identity(account);
    if (key !== accountKey) {
      clear();
      accountKey = key;
    }
    const allowed = account.source === 'desktop' ? DESKTOP_ORIGINS : OFFICIAL_BASE_URLS;
    if (!allowed.has(account.origin)) {
      clear();
      return unavailable('custom-provider', '自定义模型无法获取配额', account.source);
    }
    if (account.expiresAt !== null && account.expiresAt <= Date.now()) {
      clear();
      return unavailable('expired', `${account.source === 'desktop' ? 'Kimi 桌面版' : 'Kimi Code'}登录已过期，请重新登录`, account.source);
    }
    if (!options.forceRefresh && lastSuccess?.fetchedAt && !lastSuccess.stale && Date.now() - lastSuccess.fetchedAt * 1_000 <= CACHE_TTL_MS) {
      return lastSuccess;
    }
    if (requestInFlight) return requestInFlight;
    const currentGeneration = generation;
    const selected = account;
    const switched = () => unavailable('temporarily-unavailable', 'Kimi 账号已切换，请刷新额度');
    const pending = (async () => {
      let snapshot: KimiSubscriptionSnapshot | null = null;
      try {
        snapshot = await fetchKimiSubscription(selected, fetchImpl, lastSuccess);
      } catch {
        // Recheck the local identity before considering a stale network fallback.
      }
      if (currentGeneration !== generation) return switched();
      let current: KimiAccount | KimiSubscriptionSnapshot;
      try {
        if (selected.validateIdentity) {
          current = await selected.validateIdentity()
            ? selected
            : unavailable('temporarily-unavailable', 'Kimi 桌面版账号信息正在同步，请稍后重试', 'desktop');
        } else {
          current = await loadAccount();
        }
      } catch {
        if (currentGeneration !== generation) return switched();
        clear();
        return unavailable('temporarily-unavailable', '暂时无法读取 Kimi 本机登录信息');
      }
      if (currentGeneration !== generation) return switched();
      if (!('accessToken' in current)) {
        clear();
        return current;
      }
      if (identity(current) !== key) {
        clear();
        return switched();
      }
      if (snapshot) {
        lastSuccess = snapshot.status === 'ready' ? snapshot : null;
        return snapshot;
      }
      const message = '暂时无法读取 Kimi 订阅额度';
      if (lastSuccess) {
        lastSuccess = { ...lastSuccess, stale: true, message };
        return lastSuccess;
      }
      return {
        ...unavailable('temporarily-unavailable', message, selected.source),
        planLabel: selected.planLabel,
        stale: selected.planLabel !== null,
      };
    })();
    requestInFlight = pending;
    try {
      return await pending;
    } finally {
      if (requestInFlight === pending) requestInFlight = null;
    }
  };
}

/** Desktop and Code have independent accounts, caches and in-flight requests. */
export function createKimiSubscriptionsReader(options: {
  loadDesktopAccount?: () => Promise<KimiAccount | KimiSubscriptionSnapshot>;
  loadCodeAccount?: () => Promise<KimiAccount | KimiSubscriptionSnapshot>;
  fetchImpl?: typeof fetch;
} = {}) {
  const readers = [
    ['desktop', createKimiSubscriptionReader(options.loadDesktopAccount ?? (() => loadKimiAccount({ source: 'desktop' })), options.fetchImpl)],
    ['code', createKimiSubscriptionReader(options.loadCodeAccount ?? (() => loadKimiAccount({ source: 'code' })), options.fetchImpl)],
  ] as const;
  return (requestOptions: { forceRefresh?: boolean } = {}): Promise<KimiSubscriptionSnapshot[]> => Promise.all(
    readers.map(async ([source, read]) => {
      try {
        return { ...await read(requestOptions), source };
      } catch {
        return unavailable('temporarily-unavailable', '暂时无法读取 Kimi 订阅信息', source);
      }
    }),
  );
}

export const readKimiSubscriptions = createKimiSubscriptionsReader();

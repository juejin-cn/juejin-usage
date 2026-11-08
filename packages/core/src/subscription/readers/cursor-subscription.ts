import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { queryDbJson } from '../../parsers/sqlite.js';
import {
  mapCursorUsageSummary,
  mapCursorGrokBotUsage,
  isCursorWeeklyIncludedUsage,
  mapCursorPeriodUsage,
  type CursorSubscriptionSnapshot,
} from '../shared/cursor-subscription.js';
import {
  CursorSafeStorageError,
  unwrapCursorAccessToken,
  type CursorSafeStorageOptions,
} from './cursor-safe-storage.js';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CURSOR_USAGE_URL = 'https://cursor.com/api/usage-summary';
const CURSOR_GROK_BOT_URL = 'https://cursor.com/api/dashboard/get-sand-usage-status';
const CURSOR_PLAN_INFO_URL = 'https://cursor.com/api/dashboard/get-plan-info';
const CURSOR_PERIOD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';

interface CursorCredentials {
  token: string;
  userId: string;
}

export type CursorSubscriptionReadOptions = {
  forceRefresh?: boolean;
} & Pick<
  CursorSafeStorageOptions,
  | 'decryptString'
  | 'readKeychainPassword'
  | 'readWindowsOsCryptKey'
  | 'readLinuxPassword'
  | 'localStatePath'
  | 'platform'
>;

class CursorCredentialError extends Error {
  constructor(
    readonly kind: 'not-installed' | 'not-signed-in' | 'unavailable',
    readonly detail?: string,
  ) {
    super(detail ?? kind);
  }
}

let lastSuccess: CursorSubscriptionSnapshot | null = null;
let requestInFlight: Promise<CursorSubscriptionSnapshot> | null = null;
let credentialOptions: CursorSubscriptionReadOptions = {};

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function cursorStateDatabasePath(): string {
  const explicit = process.env.CURSOR_STATE_DB_PATH?.trim();
  if (explicit) return expandHome(explicit);
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return path.join(expandHome(xdg), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function cursorCliConfigFile(): string {
  return path.join(homedir(), '.cursor', 'cli-config.json');
}

function unavailable(
  status: Exclude<CursorSubscriptionSnapshot['status'], 'ready'>,
  message: string,
  hasAccount = false,
): CursorSubscriptionSnapshot {
  return {
    status,
    hasAccount,
    planLabel: null,
    cursorModels: null,
    otherModels: null,
    plan: null,
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string, hasAccount = false): CursorSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message, hasAccount);
  return { ...lastSuccess, hasAccount: true, stale: true, message };
}

/** Extract the provider account subject without exposing any other JWT claims. */
export function extractCursorUserId(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown };
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) return null;
    const subject = payload.sub.trim();
    const native = subject.match(/\|(user_[A-Za-z0-9_]+)$/);
    if (native) return native[1]!;
    return subject;
  } catch {
    return null;
  }
}

async function readCursorCliUserId(): Promise<string | null> {
  try {
    const document = JSON.parse(await readFile(cursorCliConfigFile(), 'utf8')) as {
      authInfo?: { authId?: unknown };
    };
    return typeof document.authInfo?.authId === 'string' && document.authInfo.authId.trim()
      ? document.authInfo.authId.trim()
      : null;
  } catch {
    return null;
  }
}

/** Cursor's dashboard expects its local JWT wrapped in this browser session cookie. */
export function buildCursorSessionCookie(userId: string, token: string): string {
  return `WorkosCursorSessionToken=${userId}%3A%3A${token}`;
}

async function readCursorCredentials(
  options: CursorSubscriptionReadOptions = {},
): Promise<CursorCredentials> {
  const dbPath = cursorStateDatabasePath();
  if (!existsSync(dbPath)) throw new CursorCredentialError('not-installed');

  let rawToken: string | null = null;
  try {
    const row = queryDbJson(dbPath, `SELECT value FROM ItemTable WHERE key = '${ACCESS_TOKEN_KEY}' LIMIT 1`, { readOnly: true, timeout: 5000, maxBuffer: 1024 * 1024 })[0];
    rawToken = typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : null;
  } catch {
    throw new CursorCredentialError('unavailable');
  }
  if (!rawToken) throw new CursorCredentialError('not-signed-in');

  let token: string;
  try {
    // Open/focus Keychain policy:
    // - Auto open/focus: never call security (no dialog); reuse in-process cache or show refresh hint.
    // - Manual refresh only: allow Keychain / Secret Service prompt when needed.
    // CSV sync always uses allowKeychainPrompt:false on its own path.
    const allowKeychainPrompt = options.forceRefresh === true;
    token = await unwrapCursorAccessToken(rawToken, {
      platform: options.platform,
      decryptString: options.decryptString,
      readKeychainPassword: options.readKeychainPassword,
      readWindowsOsCryptKey: options.readWindowsOsCryptKey,
      readLinuxPassword: options.readLinuxPassword,
      localStatePath: options.localStatePath,
      allowKeychainPrompt,
      forceKeychainRefresh: options.forceRefresh === true,
    });
  } catch (error) {
    if (error instanceof CursorSafeStorageError) {
      if (
        error.kind === 'keychain-required'
        || error.kind === 'keychain-denied'
        || error.kind === 'decrypt-failed'
        || error.kind === 'unsupported-platform'
      ) {
        throw new CursorCredentialError('unavailable', error.message);
      }
      throw new CursorCredentialError('not-signed-in', error.message);
    }
    throw new CursorCredentialError('unavailable', '暂时无法读取 Cursor 登录信息');
  }

  // JWT subject first. cli-config.json can hold a different Cursor CLI account;
  // pairing that id with the desktop access token is a persistent 401.
  const userId = extractCursorUserId(token) ?? await readCursorCliUserId();
  if (!userId) throw new CursorCredentialError('not-signed-in');
  return { token, userId };
}

async function maybeApplyWeeklyPlanUsage(
  mapped: ReturnType<typeof mapCursorUsageSummary>,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ReturnType<typeof mapCursorUsageSummary>> {
  try {
    const planInfoResponse = await fetchImpl(CURSOR_PLAN_INFO_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!planInfoResponse.ok) return mapped;
    const planInfo = await planInfoResponse.json();
    if (!isCursorWeeklyIncludedUsage(planInfo)) return mapped;

    const periodResponse = await fetchImpl(CURSOR_PERIOD_USAGE_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!periodResponse.ok) return mapped;
    const weekly = mapCursorPeriodUsage(await periodResponse.json());
    if (!weekly) return mapped;
    // Weekly Premium (and similar) expose a single period window; Auto/API pools
    // on usage-summary stay at 0% and would mislead the card.
    return {
      planLabel: mapped.planLabel,
      cursorModels: null,
      otherModels: null,
      plan: weekly,
    };
  } catch {
    return mapped;
  }
}

export async function fetchCursorSubscription(
  credentials: CursorCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorSubscriptionSnapshot> {
  const headers = {
    Accept: 'application/json',
    Cookie: buildCursorSessionCookie(credentials.userId, credentials.token),
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard?tab=usage',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  const [response, grokBot] = await Promise.all([
    fetchImpl(CURSOR_USAGE_URL, {
      method: 'GET', headers, redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    // Optional same-account pool. Failure never invalidates the main usage reading.
    fetchImpl(CURSOR_GROK_BOT_URL, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}', redirect: 'error', signal: AbortSignal.timeout(5000),
    }).then(async (result) => result.ok ? mapCursorGrokBotUsage(await result.json()) : null)
      .catch(() => null),
  ]);
  if (response.status === 401 || response.status === 403) {
    return unavailable('not-signed-in', '请先登录 Cursor', false);
  }
  if (!response.ok) throw new Error(`Cursor usage API returned ${response.status}`);
  let mapped = mapCursorUsageSummary(await response.json());
  mapped = await maybeApplyWeeklyPlanUsage(mapped, headers, fetchImpl);
  if (!mapped.cursorModels && !mapped.otherModels && !mapped.plan && !grokBot) {
    throw new Error('Cursor usage response contained no supported quota');
  }
  return {
    status: 'ready',
    hasAccount: true,
    ...mapped,
    ...(grokBot ? { grokBot } : {}),
    fetchedAt: Math.floor(Date.now() / 1_000),
    stale: false,
    message: null,
  };
}

async function fetchFreshCursorSubscription(
  options: CursorSubscriptionReadOptions,
): Promise<CursorSubscriptionSnapshot> {
  let credentials: CursorCredentials;
  try {
    credentials = await readCursorCredentials(options);
  } catch (error) {
    if (error instanceof CursorCredentialError) {
      if (error.kind === 'not-installed') {
        return unavailable('not-installed', '未检测到本机 Cursor', false);
      }
      if (error.kind === 'not-signed-in') {
        return unavailable('not-signed-in', error.detail ?? '请先登录 Cursor', false);
      }
      // Local login exists (possibly sealed); keep the card visible with refresh guidance.
      if (error.kind === 'unavailable' && error.detail) {
        return staleFallback(error.detail, true);
      }
    }
    return staleFallback('暂时无法读取 Cursor 登录信息', true);
  }

  try {
    const snapshot = await fetchCursorSubscription(credentials);
    if (snapshot.status === 'ready') lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('暂时无法读取 Cursor 订阅配额', true);
  }
}

/** Configure decrypt hooks used by subsequent {@link readCursorSubscription} calls. */
export function configureCursorSubscriptionReader(
  options: CursorSubscriptionReadOptions = {},
): void {
  credentialOptions = options;
}

export async function readCursorSubscription(
  options: CursorSubscriptionReadOptions = {},
): Promise<CursorSubscriptionSnapshot> {
  const merged = { ...credentialOptions, ...options };
  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!merged.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  // Manual refresh must not join an in-flight auto load (may still be waiting on Keychain).
  if (requestInFlight && !merged.forceRefresh) return requestInFlight;
  if (requestInFlight && merged.forceRefresh) await requestInFlight.catch(() => {});
  requestInFlight = fetchFreshCursorSubscription(merged);
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

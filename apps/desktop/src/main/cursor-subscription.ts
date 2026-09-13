import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  mapCursorUsageSummary,
  type CursorSubscriptionSnapshot,
} from '../shared/cursor-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CURSOR_USAGE_URL = 'https://cursor.com/api/usage-summary';
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';

interface CursorCredentials {
  token: string;
  userId: string;
}

class CursorCredentialError extends Error {
  constructor(readonly kind: 'not-installed' | 'not-signed-in' | 'unavailable') {
    super(kind);
  }
}

let lastSuccess: CursorSubscriptionSnapshot | null = null;
let requestInFlight: Promise<CursorSubscriptionSnapshot> | null = null;

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
): CursorSubscriptionSnapshot {
  return {
    status,
    planLabel: null,
    cursorModels: null,
    otherModels: null,
    plan: null,
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string): CursorSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message);
  return { ...lastSuccess, stale: true, message };
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

async function readCursorCredentials(): Promise<CursorCredentials> {
  const dbPath = cursorStateDatabasePath();
  if (!existsSync(dbPath)) throw new CursorCredentialError('not-installed');

  let database: DatabaseSync | null = null;
  let token: string | null = null;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const row = database.prepare(
      'SELECT value FROM ItemTable WHERE key = ? LIMIT 1',
    ).get(ACCESS_TOKEN_KEY) as { value?: unknown } | undefined;
    token = typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : null;
  } catch {
    throw new CursorCredentialError('unavailable');
  } finally {
    database?.close();
  }
  if (!token) throw new CursorCredentialError('not-signed-in');

  const userId = await readCursorCliUserId() ?? extractCursorUserId(token);
  if (!userId) throw new CursorCredentialError('not-signed-in');
  return { token, userId };
}

export async function fetchCursorSubscription(
  credentials: CursorCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<CursorSubscriptionSnapshot> {
  const response = await fetchImpl(CURSOR_USAGE_URL, {
    method: 'GET',
    headers: {
      Accept: '*/*',
      Cookie: buildCursorSessionCookie(credentials.userId, credentials.token),
      Origin: 'https://cursor.com',
      Referer: 'https://cursor.com/dashboard?tab=usage',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    return unavailable('not-signed-in', '请先登录 Cursor');
  }
  if (!response.ok) throw new Error(`Cursor usage API returned ${response.status}`);
  const mapped = mapCursorUsageSummary(await response.json());
  if (!mapped.cursorModels && !mapped.otherModels && !mapped.plan) {
    throw new Error('Cursor usage response contained no supported quota');
  }
  return {
    status: 'ready',
    ...mapped,
    fetchedAt: Math.floor(Date.now() / 1_000),
    stale: false,
    message: null,
  };
}

async function fetchFreshCursorSubscription(): Promise<CursorSubscriptionSnapshot> {
  let credentials: CursorCredentials;
  try {
    credentials = await readCursorCredentials();
  } catch (error) {
    if (error instanceof CursorCredentialError) {
      if (error.kind === 'not-installed') {
        return unavailable('not-installed', '未检测到本机 Cursor');
      }
      if (error.kind === 'not-signed-in') {
        return unavailable('not-signed-in', '请先登录 Cursor');
      }
    }
    return staleFallback('暂时无法读取 Cursor 登录信息');
  }

  try {
    const snapshot = await fetchCursorSubscription(credentials);
    if (snapshot.status === 'ready') lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('暂时无法读取 Cursor 订阅配额');
  }
}

export async function readCursorSubscription(
  options: { forceRefresh?: boolean } = {},
): Promise<CursorSubscriptionSnapshot> {
  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshCursorSubscription();
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

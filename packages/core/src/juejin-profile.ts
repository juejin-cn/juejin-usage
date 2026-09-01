/**
 * Refresh the locally cached Juejin display name / avatar from the public
 * user card. Login association writes a snapshot; cloud upload does not
 * refresh it, and `tud-session` needs a browser cookie.
 */
import { saveConfig } from './config.js';
import type { TudConfig } from './types.js';

const JUEJIN_USER_GET_URL = 'https://api.juejin.cn/user_api/v1/user/get';
export const JUEJIN_PROFILE_AUTO_MIN_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const DISPLAY_NAME_MAX_LEN = 64;
const AVATAR_URL_MAX_LEN = 2048;

export type JuejinProfileSyncReason =
  | 'not_linked'
  | 'throttled'
  | 'fetch_failed'
  | 'unchanged'
  | 'updated';

export interface JuejinProfileSyncResult {
  changed: boolean;
  reason: JuejinProfileSyncReason;
}

export interface JuejinPublicProfile {
  userName: string | null;
  avatarLarge: string | null;
}

export interface SyncJuejinProfileOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

const lastAttemptByUser = new Map<string, number>();
const inFlightByDir = new Map<string, Promise<JuejinProfileSyncResult>>();

export function resetJuejinProfileSyncStateForTests(): void {
  lastAttemptByUser.clear();
  inFlightByDir.clear();
}

function stripWrappingQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function looksLikePlainJuejinUserId(value: string): boolean {
  return /^\d{6,20}$/.test(value);
}

export function resolveProfileOriginUserId(config: TudConfig): string | null {
  const origin = stripWrappingQuotes(config.juejin.originUserId?.trim() || '');
  if (origin && looksLikePlainJuejinUserId(origin)) return origin;
  const token = stripWrappingQuotes(config.juejin.token?.trim() || '');
  if (token && looksLikePlainJuejinUserId(token)) return token;
  return null;
}

export function isUsableDisplayName(name: string): boolean {
  const trimmed = name.trim();
  return Boolean(trimmed) && trimmed.length <= DISPLAY_NAME_MAX_LEN;
}

export function isUsableAvatarUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > AVATAR_URL_MAX_LEN || /\s/.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function parseJuejinUserGetPayload(
  raw: unknown,
  originUserId: string,
): JuejinPublicProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body.err_no !== 0 && body.err_no !== undefined) return null;
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const user = data as Record<string, unknown>;

  const idRaw = user.user_id;
  const userId =
    typeof idRaw === 'string' || typeof idRaw === 'number'
      ? String(idRaw).trim()
      : '';
  if (userId && userId !== originUserId) return null;

  const rawName = typeof user.user_name === 'string' ? user.user_name.trim() : '';
  const rawAvatar =
    typeof user.avatar_large === 'string' ? user.avatar_large.trim() : '';
  return {
    userName: rawName && isUsableDisplayName(rawName) ? rawName : null,
    avatarLarge: rawAvatar && isUsableAvatarUrl(rawAvatar) ? rawAvatar : null,
  };
}

export async function fetchJuejinPublicProfile(
  originUserId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JuejinPublicProfile | null> {
  const url = new URL(JUEJIN_USER_GET_URL);
  url.searchParams.set('aid', '2608');
  url.searchParams.set('user_id', originUserId);
  url.searchParams.set('not_self', '1');

  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        Referer: 'https://juejin.cn/',
        'User-Agent': 'Mozilla/5.0 (compatible; jusage)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    return parseJuejinUserGetPayload(body, originUserId);
  } catch {
    return null;
  }
}

function currentProfile(config: TudConfig): {
  userName: string | null;
  avatarLarge: string | null;
} {
  return {
    userName: config.juejin.userName?.trim() || null,
    avatarLarge: config.juejin.avatarLarge?.trim() || null,
  };
}

async function syncJuejinProfileUnlocked(
  dataDir: string,
  config: TudConfig,
  opts: SyncJuejinProfileOptions,
): Promise<JuejinProfileSyncResult> {
  const originUserId = resolveProfileOriginUserId(config);
  if (!originUserId) return { changed: false, reason: 'not_linked' };

  const nowMs = opts.nowMs ?? Date.now();
  const lastAttemptMs = lastAttemptByUser.get(originUserId) ?? 0;
  if (
    !opts.force &&
    lastAttemptMs > 0 &&
    nowMs - lastAttemptMs < JUEJIN_PROFILE_AUTO_MIN_INTERVAL_MS
  ) {
    return { changed: false, reason: 'throttled' };
  }
  lastAttemptByUser.set(originUserId, nowMs);

  const profile = await fetchJuejinPublicProfile(originUserId, opts.fetchImpl);
  if (!profile) return { changed: false, reason: 'fetch_failed' };

  const current = currentProfile(config);
  const nextName = profile.userName ?? current.userName;
  const nextAvatar = profile.avatarLarge ?? current.avatarLarge;
  if (nextName === current.userName && nextAvatar === current.avatarLarge) {
    return { changed: false, reason: 'unchanged' };
  }

  config.juejin.userName = nextName;
  config.juejin.avatarLarge = nextAvatar;
  await saveConfig(dataDir, config);
  return { changed: true, reason: 'updated' };
}

/** Fetch the public Juejin card and write usable fields into config.json. */
export async function syncJuejinProfile(
  dataDir: string,
  config: TudConfig,
  opts: SyncJuejinProfileOptions = {},
): Promise<JuejinProfileSyncResult> {
  const existing = inFlightByDir.get(dataDir);
  if (existing) return existing;
  const pending = syncJuejinProfileUnlocked(dataDir, config, opts).finally(() => {
    inFlightByDir.delete(dataDir);
  });
  inFlightByDir.set(dataDir, pending);
  return pending;
}

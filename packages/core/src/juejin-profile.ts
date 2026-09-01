/**
 * Refresh the locally cached Juejin display name / avatar via the public
 * aiusage `tud-session` contract (same envelope as online login).
 */
import { resolveLinkedUserId, saveConfig } from './config.js';
import type { TudConfig } from './types.js';
import { normalizeApiUrl } from './upload/state.js';

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

export interface JuejinSessionProfile {
  userName: string | null;
  avatarLarge: string | null;
  originUserId: string | null;
}

export interface SyncJuejinProfileOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

const lastAttemptByToken = new Map<string, number>();
const inFlightByDir = new Map<string, Promise<JuejinProfileSyncResult>>();

export function resetJuejinProfileSyncStateForTests(): void {
  lastAttemptByToken.clear();
  inFlightByDir.clear();
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

export function parseTudSessionPayload(raw: unknown): JuejinSessionProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body.success === false) return null;
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const session = data as Record<string, unknown>;

  const rawName = typeof session.userName === 'string' ? session.userName.trim() : '';
  const rawAvatar =
    typeof session.avatarLarge === 'string' ? session.avatarLarge.trim() : '';
  const origin =
    typeof session.originUserId === 'string' ? session.originUserId.trim() : '';
  return {
    userName: rawName && isUsableDisplayName(rawName) ? rawName : null,
    avatarLarge: rawAvatar && isUsableAvatarUrl(rawAvatar) ? rawAvatar : null,
    originUserId: origin || null,
  };
}

export async function fetchJuejinSessionProfile(
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JuejinSessionProfile | null> {
  const url = `${normalizeApiUrl(apiUrl)}/functions/tud-session`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
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
    return parseTudSessionPayload(body);
  } catch {
    return null;
  }
}

function currentProfile(config: TudConfig): {
  userName: string | null;
  avatarLarge: string | null;
  originUserId: string | null;
} {
  return {
    userName: config.juejin.userName?.trim() || null,
    avatarLarge: config.juejin.avatarLarge?.trim() || null,
    originUserId: config.juejin.originUserId?.trim() || null,
  };
}

async function syncJuejinProfileUnlocked(
  dataDir: string,
  config: TudConfig,
  opts: SyncJuejinProfileOptions,
): Promise<JuejinProfileSyncResult> {
  const token = resolveLinkedUserId(config.deviceId, config.juejin.token);
  const apiUrl = normalizeApiUrl(config.juejin.apiUrl ?? '');
  if (!token || !apiUrl) return { changed: false, reason: 'not_linked' };

  const nowMs = opts.nowMs ?? Date.now();
  const lastAttemptMs = lastAttemptByToken.get(token) ?? 0;
  if (
    !opts.force &&
    lastAttemptMs > 0 &&
    nowMs - lastAttemptMs < JUEJIN_PROFILE_AUTO_MIN_INTERVAL_MS
  ) {
    return { changed: false, reason: 'throttled' };
  }
  lastAttemptByToken.set(token, nowMs);

  const profile = await fetchJuejinSessionProfile(apiUrl, token, opts.fetchImpl);
  if (!profile) return { changed: false, reason: 'fetch_failed' };

  const current = currentProfile(config);
  const nextName = profile.userName ?? current.userName;
  const nextAvatar = profile.avatarLarge ?? current.avatarLarge;
  const nextOrigin = profile.originUserId ?? current.originUserId;
  if (
    nextName === current.userName &&
    nextAvatar === current.avatarLarge &&
    nextOrigin === current.originUserId
  ) {
    return { changed: false, reason: 'unchanged' };
  }

  config.juejin.userName = nextName;
  config.juejin.avatarLarge = nextAvatar;
  config.juejin.originUserId = nextOrigin;
  await saveConfig(dataDir, config);
  return { changed: true, reason: 'updated' };
}

/** Pull tud-session profile fields into config.json. */
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

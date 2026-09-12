/**
 * Online ↔ desktop/CLI association via Query + protocol / local panel.
 *
 * Online: `?login_from_client=desktop|cli&port=`
 * CLI local write: `http://127.0.0.1:port/?user_id=&origin_user_id=&user_name=&avatar_large=`
 * Desktop write: `juejin-usage://link?user_id=&origin_user_id=&user_name=&avatar_large=`
 *
 * `user_id` carries the opaque `jau.` token; `origin_user_id` is display-only.
 */

export const LOGIN_FROM_CLIENT_PARAM = 'login_from_client';
export const PORT_PARAM = 'port';
export const USER_ID_PARAM = 'user_id';
export const ORIGIN_USER_ID_PARAM = 'origin_user_id';
export const USER_NAME_PARAM = 'user_name';
export const AVATAR_LARGE_PARAM = 'avatar_large';

export const DEFAULT_CLI_PORT = 8452;
export const JUEJIN_HOME = 'https://juejin.cn';
/** Standard online entry; its root route preserves Query while redirecting to dashboard. */
const DEFAULT_PUBLIC_API_ROOT = 'https://api.juejin.cn/aiusage_api';
export const JUEJIN_ONLINE_PAGE = 'https://juejin.cn/aiusage/';
export const DESKTOP_PROTOCOL_SCHEME = 'juejin-usage';

/** Opaque `jau.` tokens exceed plain Juejin business id length. */
const ENCRYPTED_USER_ID_MAX_LEN = 512;
const ORIGIN_USER_ID_MAX_LEN = 64;

export type LoginFromClient = 'desktop' | 'cli';

export type JuejinUserProfile = {
  /** Opaque `jau.` token for auth header + client writeback (`user_id`). */
  userId: string;
  /** Plain Juejin id for Settings display. */
  originUserId: string;
  userName: string;
  avatarLarge: string;
};

export type ProfileLinkFields = {
  originUserId?: string;
  userName?: string;
  avatarLarge?: string;
};

export function parseLoginFromClient(
  value: string | null | undefined,
): LoginFromClient | null {
  if (value === 'desktop' || value === 'cli') return value;
  return null;
}

export function parseCliPort(value: string | null | undefined): number {
  if (value == null || value === '') return DEFAULT_CLI_PORT;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_CLI_PORT;
  return n;
}

/** Validate opaque upload identity (`jau.…` or legacy plain id during transition). */
export function isValidUserId(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= ENCRYPTED_USER_ID_MAX_LEN &&
    !/\s/.test(trimmed)
  );
}

export function isValidOriginUserId(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= ORIGIN_USER_ID_MAX_LEN &&
    !/\s/.test(trimmed)
  );
}

function normalizeOptionalText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** Strip accidental JSON quotes from query / stored ids. */
function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function applyProfileParams(
  url: URL,
  opts: ProfileLinkFields,
): void {
  const originUserId = normalizeOptionalText(opts.originUserId);
  const userName = normalizeOptionalText(opts.userName);
  const avatarLarge = normalizeOptionalText(opts.avatarLarge);
  if (originUserId && isValidOriginUserId(originUserId)) {
    url.searchParams.set(ORIGIN_USER_ID_PARAM, originUserId);
  }
  if (userName) url.searchParams.set(USER_NAME_PARAM, userName);
  if (avatarLarge) url.searchParams.set(AVATAR_LARGE_PARAM, avatarLarge);
}

/** Build the online page URL clients open for Juejin login association. */
export function buildJuejinLoginUrl(opts: {
  loginFromClient: LoginFromClient;
  port?: number;
}): string {
  const url = new URL(JUEJIN_ONLINE_PAGE);
  url.searchParams.set(LOGIN_FROM_CLIENT_PARAM, opts.loginFromClient);
  // Always include port for cli so the online page can return to the right panel.
  if (opts.loginFromClient === 'cli') {
    url.searchParams.set(
      PORT_PARAM,
      String(opts.port ?? DEFAULT_CLI_PORT),
    );
  }
  return url.toString();
}

export function buildCliLocalLinkUrl(opts: {
  port: number;
  userId: string;
  originUserId?: string;
  userName?: string;
  avatarLarge?: string;
}): string {
  const url = new URL(`http://127.0.0.1:${opts.port}/`);
  url.searchParams.set(USER_ID_PARAM, opts.userId);
  applyProfileParams(url, opts);
  return url.toString();
}

export function buildDesktopDeepLink(
  userId: string,
  profile?: ProfileLinkFields,
): string {
  const url = new URL(`${DESKTOP_PROTOCOL_SCHEME}://link`);
  url.searchParams.set(USER_ID_PARAM, userId);
  applyProfileParams(url, profile ?? {});
  return url.toString();
}

export type ClientLinkSearch = {
  loginFromClient: LoginFromClient | null;
  port: number;
  userId: string | null;
  originUserId: string;
  userName: string;
  avatarLarge: string;
};

export function readClientLinkSearch(
  search = window.location.search,
): ClientLinkSearch {
  const params = new URLSearchParams(search);
  const rawUid = stripWrappingQuotes(params.get(USER_ID_PARAM) ?? '');
  const rawOrigin = stripWrappingQuotes(params.get(ORIGIN_USER_ID_PARAM) ?? '');
  return {
    loginFromClient: parseLoginFromClient(
      params.get(LOGIN_FROM_CLIENT_PARAM),
    ),
    port: parseCliPort(params.get(PORT_PARAM)),
    userId: isValidUserId(rawUid) ? rawUid : null,
    originUserId: isValidOriginUserId(rawOrigin) ? rawOrigin : '',
    userName: normalizeOptionalText(params.get(USER_NAME_PARAM)),
    avatarLarge: normalizeOptionalText(params.get(AVATAR_LARGE_PARAM)),
  };
}

/** Captured once at module load in case later code rewrites the URL. */
export const bootClientLinkSearch: ClientLinkSearch =
  typeof window !== 'undefined'
    ? readClientLinkSearch(window.location.search)
    : {
        loginFromClient: null,
        port: DEFAULT_CLI_PORT,
        userId: null,
        originUserId: '',
        userName: '',
        avatarLarge: '',
      };

/** Prefer live URL, fall back to boot capture. */
export function resolveClientLinkSearch(): ClientLinkSearch {
  const live = readClientLinkSearch(window.location.search);
  if (live.loginFromClient || live.userId) return live;
  if (
    bootClientLinkSearch.loginFromClient ||
    bootClientLinkSearch.userId
  ) {
    return bootClientLinkSearch;
  }
  return live;
}

/** Remove association Query keys without a full navigation. */
export function stripClientLinkQuery(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(LOGIN_FROM_CLIENT_PARAM);
  url.searchParams.delete(PORT_PARAM);
  url.searchParams.delete(USER_ID_PARAM);
  url.searchParams.delete(ORIGIN_USER_ID_PARAM);
  url.searchParams.delete(USER_NAME_PARAM);
  url.searchParams.delete(AVATAR_LARGE_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, '', next);
}

function tudSessionUrl(): string {
  const base = (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/$/, '');
  return `${base || DEFAULT_PUBLIC_API_ROOT}/functions/tud-session`;
}

/**
 * Online dashboard: cookie → server `tud-session` → opaque `jau.` token + profile.
 */
export async function fetchJuejinUserProfile(): Promise<JuejinUserProfile | null> {
  const res = await fetch(tudSessionUrl(), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const success = (body as { success?: unknown }).success;
  const data = (body as { data?: unknown }).data;
  if (success === false || !data || typeof data !== 'object') return null;

  const encrypted = (data as { encryptedUserId?: unknown }).encryptedUserId;
  const origin = (data as { originUserId?: unknown }).originUserId;
  if (typeof encrypted !== 'string' || !isValidUserId(encrypted)) return null;
  if (typeof origin !== 'string' || !isValidOriginUserId(origin)) return null;

  const userNameRaw = (data as { userName?: unknown }).userName;
  const avatarRaw = (data as { avatarLarge?: unknown }).avatarLarge;
  return {
    userId: encrypted.trim(),
    originUserId: origin.trim(),
    userName: typeof userNameRaw === 'string' ? userNameRaw.trim() : '',
    avatarLarge: typeof avatarRaw === 'string' ? avatarRaw.trim() : '',
  };
}

/** @deprecated Prefer fetchJuejinUserProfile */
export async function fetchJuejinUserId(): Promise<string | null> {
  const profile = await fetchJuejinUserProfile();
  return profile?.userId ?? null;
}

/**
 * Invoke desktop custom protocol without navigating the current tab away.
 * Hidden iframe only (once).
 */
export function writeUserIdToDesktop(
  userId: string,
  profile?: ProfileLinkFields,
): void {
  const href = buildDesktopDeepLink(userId, profile);
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = href;
  document.body.appendChild(iframe);
  window.setTimeout(() => iframe.remove(), 2000);
}

/** Brief pause so the online page can paint a success toast before leaving. */
const CLI_RETURN_DELAY_MS = 600;

/**
 * Return to the local CLI panel in the **same tab** (A ← B).
 * Uses `location.replace` so the online page is not left in the history stack
 * (top-level nav HTTPS→HTTP is allowed; fetch would not be).
 */
export function openCliLocalWrite(
  userId: string,
  port: number,
  profile?: ProfileLinkFields,
): void {
  const href = buildCliLocalLinkUrl({
    port,
    userId,
    originUserId: profile?.originUserId,
    userName: profile?.userName,
    avatarLarge: profile?.avatarLarge,
  });
  window.setTimeout(() => {
    window.location.replace(href);
  }, CLI_RETURN_DELAY_MS);
}

/** Desktop Electron exposes `window.tud`; CLI browser panel does not. */
export function detectLoginFromClient(): LoginFromClient {
  return typeof window !== 'undefined' &&
    typeof (window as { tud?: unknown }).tud !== 'undefined'
    ? 'desktop'
    : 'cli';
}

export function resolveCliPanelPort(): number {
  const fromLocation = window.location.port;
  return parseCliPort(fromLocation || String(DEFAULT_CLI_PORT));
}

export type OpenJuejinLoginResult = { ok: boolean; message?: string };

/**
 * Open the online Juejin association page.
 * Desktop: `tud.openExternal` IPC → OS browser.
 * CLI panel: same-tab navigate (A → B) so popup blockers cannot swallow the jump.
 */
export async function openJuejinLogin(): Promise<OpenJuejinLoginResult> {
  const loginFromClient = detectLoginFromClient();
  const port =
    loginFromClient === 'cli' ? resolveCliPanelPort() : undefined;
  const url = buildJuejinLoginUrl({ loginFromClient, port });

  const openExternal = (
    window as {
      tud?: {
        openExternal?: (href: string) => Promise<OpenJuejinLoginResult>;
      };
    }
  ).tud?.openExternal;

  if (typeof openExternal === 'function') {
    return openExternal(url);
  }

  // CLI / browser panel: stay in one tab (A → B → later A with user_id).
  window.location.assign(url);
  return { ok: true };
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TTL_MS = 10 * 60_000;
const COOKIE = 'tud_tauri_login';
const LOGIN_PATH = '/functions/tud-desktop-login';
const START_PATH = '/desktop-login/start';

export function isAssociationUrl(url: URL): boolean {
  return url.origin === 'https://juejin.cn' && !url.username && !url.password
    && (url.pathname === '/aiusage' || url.pathname.startsWith('/aiusage/'))
    && url.searchParams.has('login_from_client');
}

export function parseLoginPayload(params: URLSearchParams) {
  const token = params.get('user_id')?.trim() ?? '';
  if (!token || token.length > 512 || /\s/.test(token)) throw new Error('INVALID_LOGIN_TOKEN');
  const originUserId = params.get('origin_user_id')?.trim();
  if (originUserId && (originUserId.length > 64 || /\s/.test(originUserId))) throw new Error('INVALID_LOGIN_PROFILE');
  const userName = params.get('user_name')?.trim();
  const avatarLarge = params.get('avatar_large')?.trim();
  if ((userName?.length ?? 0) > 256 || (avatarLarge?.length ?? 0) > 2048) throw new Error('INVALID_LOGIN_PROFILE');
  if (avatarLarge && !/^https:\/\//.test(avatarLarge)) throw new Error('INVALID_LOGIN_PROFILE');
  return { juejin: { enabled: true, token,
    ...(originUserId ? { originUserId } : {}), ...(userName ? { userName } : {}),
    ...(avatarLarge ? { avatarLarge } : {}),
  } };
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One browser flow per host. Tickets and cookies never contain upload credentials. */
export function createDesktopLoginHandler(options: {
  hostKey: string;
  apply: (payload: ReturnType<typeof parseLoginPayload>) => Promise<void>;
  linked: () => void;
  now?: () => number;
}) {
  let session: { ticket: string; cookie: string; target: string; expires: number; started: boolean } | null = null;
  const now = options.now ?? Date.now;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const port = req.socket.localPort;
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(req.url ?? '/', origin);
    const callback = url.pathname === '/' && url.searchParams.has('user_id');
    if (url.pathname !== LOGIN_PATH && url.pathname !== START_PATH && !callback) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    const respond = (status: number, message: string) => {
      res.statusCode = status; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(message);
    };
    if (req.headers.host !== `127.0.0.1:${port}` || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      respond(403, 'LOGIN_ACCESS_DENIED'); return true;
    }
    if (url.pathname === LOGIN_PATH) {
      // Native IPC initiates a flow; websites cannot arm or replace it.
      if (req.method !== 'POST' || !options.hostKey || !equal(String(req.headers['x-tud-host-key'] ?? ''), options.hostKey)) {
        respond(403, 'LOGIN_ACCESS_DENIED'); return true;
      }
      let target: URL;
      try { target = new URL(url.searchParams.get('target') ?? 'https://invalid.local'); }
      catch { respond(400, 'INVALID_LOGIN_TARGET'); return true; }
      if (!isAssociationUrl(target)) { respond(400, 'INVALID_LOGIN_TARGET'); return true; }
      target.searchParams.set('login_from_client', 'cli');
      target.searchParams.set('port', String(port));
      session = { ticket: randomBytes(32).toString('hex'), cookie: randomBytes(32).toString('hex'), target: target.href, expires: now() + TTL_MS, started: false };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ url: `${origin}${START_PATH}?ticket=${session.ticket}` })); return true;
    }
    if (req.method !== 'GET') { respond(405, 'METHOD_NOT_ALLOWED'); return true; }
    if (!session || session.expires <= now()) { session = null; respond(410, '关联已过期，请返回客户端重新发起。'); return true; }
    if (url.pathname === START_PATH) {
      if (session.started || !equal(url.searchParams.get('ticket') ?? '', session.ticket)) { respond(403, 'LOGIN_ACCESS_DENIED'); return true; }
      session.started = true;
      res.setHeader('Set-Cookie', `${COOKIE}=${session.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
      res.statusCode = 302; res.setHeader('Location', session.target); res.end(); return true;
    }
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    if (!session.started || !equal(cookie, session.cookie)) { respond(403, 'LOGIN_ACCESS_DENIED'); return true; }
    // Consume before async work to reject replay and concurrent callbacks.
    session = null;
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    try {
      const payload = parseLoginPayload(url.searchParams);
      await options.apply(payload);
      options.linked();
      // Never reflect the token or profile into the browser document.
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>关联完成</title><p>已关联掘金账号，可以关闭此页面并返回 Juejin Usage Tauri。</p>');
    } catch {
      respond(400, '关联失败，请返回客户端重新发起。');
    }
    return true;
  };
}

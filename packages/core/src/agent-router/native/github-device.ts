import { setTimeout as delay } from 'node:timers/promises';

interface DeviceGrantOptions {
  origin: string;
  clientId: string;
  scope?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** GitHub device authorization with bounded polling and explicit cancellation. */
export async function beginGithubDeviceGrant(options: DeviceGrantOptions) {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('SUBSCRIPTION_LOGIN_FAILED');
  }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const fetcher = options.fetcher ?? fetch;
  async function post(path: string, fields: Record<string, string>, timeout = 15000): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const response = await fetcher(new URL(path, origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: options.clientId, ...fields }),
    });
    if (!response.ok) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
    return body as Record<string, unknown>;
  }
  const started = now();
  const grant = await post('/login/device/code', options.scope ? { scope: options.scope } : {});
  const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (typeof grant.device_code !== 'string' || !grant.device_code || typeof grant.user_code !== 'string' || !grant.user_code
    || typeof grant.verification_uri !== 'string' || !seconds(grant.expires_in)) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
  const verification = new URL(grant.verification_uri);
  if (verification.origin !== origin.origin || verification.username || verification.password) throw new Error('SUBSCRIPTION_LOGIN_FAILED');
  const deadline = started + grant.expires_in * 1000;
  let interval = seconds(grant.interval) ? grant.interval * 1000 : 5000;
  let pending: Promise<string> | undefined;
  async function poll(): Promise<string> {
    for (;;) {
      signal.throwIfAborted();
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error('SUBSCRIPTION_LOGIN_TIMEOUT');
      await wait(Math.min(interval, remaining), signal);
      if (now() >= deadline) throw new Error('SUBSCRIPTION_LOGIN_TIMEOUT');
      const token = await post('/login/oauth/access_token', {
        device_code: grant.device_code as string,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }, Math.max(1, Math.min(15000, deadline - now())));
      signal.throwIfAborted();
      if (now() >= deadline) throw new Error('SUBSCRIPTION_LOGIN_TIMEOUT');
      if (typeof token.access_token === 'string' && token.access_token && !token.error) return token.access_token;
      if (token.error === 'authorization_pending') continue;
      if (token.error === 'slow_down') {
        interval = Math.max(interval + 5000, seconds(token.interval) ? token.interval * 1000 : 0);
        continue;
      }
      if (token.error === 'expired_token') throw new Error('SUBSCRIPTION_LOGIN_TIMEOUT');
      if (token.error === 'access_denied') throw new Error('SUBSCRIPTION_CANCELLED');
      throw new Error('SUBSCRIPTION_LOGIN_FAILED');
    }
  }
  return {
    url: verification.href, instructions: `输入验证码：${grant.user_code}`, method: 'auto' as const,
    token: () => pending ??= poll(),
    cancel: () => controller.abort(new Error('SUBSCRIPTION_CANCELLED')),
  };
}

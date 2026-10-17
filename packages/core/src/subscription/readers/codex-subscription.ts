import { nonNegativeNumber } from '../shared/subscription-amounts.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { codexPlanLabel, mapCodexRateLimitWindows, type CodexSubscriptionSnapshot } from '../shared/codex-subscription.js';
import { createSubscriptionCache } from './subscription-cache.js';
import { fetchSubscription } from '../transport.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function claims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string') return {};
  try { return record(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))); }
  catch { return {}; }
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
export function parseCodexCredentials(value: unknown) {
  const auth = record(value), tokens = record(auth.tokens);
  const info = record(claims(tokens.id_token)['https://api.openai.com/auth']);
  return {
    unsupported: auth.auth_mode === 'apikey' || (!tokens.access_token && Boolean(auth.OPENAI_API_KEY)),
    accessToken: text(tokens.access_token),
    accountId: text(tokens.account_id) || text(info.chatgpt_account_id),
    planLabel: codexPlanLabel(info.chatgpt_plan_type),
    expiresAt: typeof claims(tokens.access_token).exp === 'number' ? Number(claims(tokens.access_token).exp) * 1000 : null,
  };
}
export function mapCodexUsage(value: unknown) {
  const data = record(value), limits = record(data.rate_limit);
  const window = (value: unknown) => {
    const raw = record(value);
    return { usedPercent: raw.used_percent, resetsAt: raw.reset_at, windowDurationMins: Number(raw.limit_window_seconds) / 60 };
  };
  const rawCredits = record(data.credits);
  const resetCount = nonNegativeNumber(record(data.rate_limit_reset_credits).available_count);
  const resetCredits = resetCount !== null && Number.isSafeInteger(resetCount)
    ? { availableCount: resetCount } : undefined;
  const balance = nonNegativeNumber(rawCredits.balance);
  const credits = {
    ...(balance === null ? {} : { balance }),
    ...(typeof rawCredits.unlimited === 'boolean' ? { unlimited: rawCredits.unlimited } : {}),
    ...(typeof rawCredits.has_credits === 'boolean' ? { hasCredits: rawCredits.has_credits } : {}),
  };
  return { ...(resetCredits ? { resetCredits } : {}), ...(Object.keys(credits).length ? { credits } : {}), planLabel: codexPlanLabel(data.plan_type), ...mapCodexRateLimitWindows({ primary: window(limits.primary_window), secondary: window(limits.secondary_window) }) };
}
function unavailable(status: CodexSubscriptionSnapshot['status'], message: string, hasAccount = false, planLabel: string | null = null): CodexSubscriptionSnapshot {
  return { status, message, hasAccount, planLabel, fiveHour: null, weekly: null, fetchedAt: null, stale: false };
}
export function createCodexSubscriptionReader(deps: {
  readAuth: () => Promise<string>; fetch: typeof fetch; now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = createSubscriptionCache<CodexSubscriptionSnapshot>(now);
  return async (options: { forceRefresh?: boolean } = {}): Promise<CodexSubscriptionSnapshot> => {
    let raw: string;
    try { raw = await deps.readAuth(); }
    catch (error) {
      const denied = (error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM';
      return cache('missing', async () => unavailable(denied ? 'access-denied' : 'not-signed-in', denied ? '无法读取 Codex 登录信息，请检查文件权限' : '请先使用 ChatGPT 账号登录 Codex', denied));
    }
    const key = createHash('sha256').update(raw).digest('hex');
    return cache(key, async () => {
      let auth: unknown;
      try { auth = JSON.parse(raw); } catch { return unavailable('access-denied', 'Codex 登录信息损坏，请重新登录', true); }
      const credentials = parseCodexCredentials(auth);
      const fail = (status: CodexSubscriptionSnapshot['status'], message: string) => unavailable(status, message, true, credentials.planLabel);
      if (credentials.unsupported) return unavailable('unsupported-account', '当前 Codex 使用 API key，无法读取订阅额度');
      if (!credentials.accessToken) return unavailable('not-signed-in', '请先使用 ChatGPT 账号登录 Codex');
      if (credentials.expiresAt !== null && credentials.expiresAt <= now()) return fail('expired', 'Codex 登录已过期，请重新登录');
      if (!credentials.accountId) return fail('access-denied', 'Codex 登录信息缺少账号标识，请重新登录');
      try {
        const response = await deps.fetch(USAGE_URL, {
          headers: { Authorization: `Bearer ${credentials.accessToken}`, 'ChatGPT-Account-Id': credentials.accountId, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000), redirect: 'error',
        });
        if (response.status === 401) return fail('expired', 'Codex 登录已过期，请重新登录');
        if (response.status === 403) return fail('access-denied', 'Codex 额度访问受限，请检查账号权限');
        if (response.status === 429) return fail('unavailable', 'Codex 额度请求过于频繁，请稍后重试');
        if (!response.ok) return fail('unavailable', '暂时无法读取 Codex 额度');
        const windows = mapCodexUsage(await response.json());
        if (!windows.fiveHour && !windows.weekly && !windows.credits && !windows.resetCredits) return fail('unavailable', 'Codex 暂未返回可用额度');
        return { status: 'ready', hasAccount: true, ...windows, planLabel: windows.planLabel ?? credentials.planLabel, fetchedAt: Math.floor(now() / 1000), stale: false, message: null };
      } catch { return fail('unavailable', '网络异常或读取超时，暂时无法读取 Codex 额度'); }
    }, options.forceRefresh);
  };
}
function authPath(): string {
  const configured = process.env.CODEX_HOME?.trim();
  const home = configured === '~' ? homedir() : configured?.startsWith('~/') ? path.join(homedir(), configured.slice(2)) : configured;
  return path.join(home ? path.resolve(home) : path.join(homedir(), '.codex'), 'auth.json');
}
/** Read subscription usage with local credentials; never rotate or persist tokens. */
export const readCodexSubscription = createCodexSubscriptionReader({ readAuth: () => readFile(authPath(), 'utf8'), fetch: fetchSubscription });

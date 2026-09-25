import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import {
  mapZcodeQuota,
  zcodePlanLabel,
  zcodeResponseAuthFailed,
  type ZcodeSubscriptionSnapshot,
} from '../shared/zcode-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const ZCODE_BILLING_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/current';
const BUILTIN_PROVIDER_IDS = new Set([
  'builtin:zai',
  'builtin:zai-coding-plan',
  'builtin:zai-start-plan',
  'builtin:bigmodel',
  'builtin:bigmodel-coding-plan',
  'builtin:bigmodel-start-plan',
]);

interface ZcodeAccountCredentials {
  token: string;
  /**
   * BigModel's quota endpoint validates `oauth:bigmodel:access_token` instead
   * of the zcode JWT that authorizes the billing endpoint.
   */
  quotaToken?: string;
  provider: 'zai' | 'bigmodel';
}

let lastSuccess: ZcodeSubscriptionSnapshot | null = null;
let requestInFlight: Promise<ZcodeSubscriptionSnapshot> | null = null;

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function zcodeHome(): string {
  const configured = process.env.ZCODE_HOME?.trim();
  return configured ? expandHome(configured) : path.join(homedir(), '.zcode');
}

function credentialsPath(): string {
  return path.join(zcodeHome(), 'v2', 'credentials.json');
}

function configPath(): string {
  return path.join(zcodeHome(), 'v2', 'config.json');
}

function unavailable(
  status: Exclude<ZcodeSubscriptionSnapshot['status'], 'ready'>,
  message: string,
): ZcodeSubscriptionSnapshot {
  return {
    status,
    planLabel: null,
    provider: null,
    limits: [],
    fetchedAt: null,
    stale: false,
    message,
  };
}

function staleFallback(message: string): ZcodeSubscriptionSnapshot {
  if (!lastSuccess) return unavailable('temporarily-unavailable', message);
  return { ...lastSuccess, stale: true, message };
}

function credentialSecret(): string {
  if (process.env.ZCODE_CREDENTIAL_SECRET) return process.env.ZCODE_CREDENTIAL_SECRET;
  let username = 'unknown';
  try { username = userInfo().username; } catch { /* fallback is intentional */ }
  return `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`;
}

/** Decrypt ZCode's same-device `enc:v1` credential values without persisting plaintext. */
export function decryptZcodeCredential(value: unknown, secret = credentialSecret()): string | null {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return typeof value === 'string' ? value : null;
  try {
    const [nonce, tag, ciphertext] = value.slice('enc:v1:'.length).split('.');
    if (!nonce || !tag || !ciphertext) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      createHash('sha256').update(secret).digest(),
      Buffer.from(nonce, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractBillingPlan(value: unknown): string | null {
  const root = asRecord(value);
  const data = asRecord(root?.data) ?? root;
  if (!data || !Array.isArray(data.plans)) return null;
  const active = data.plans.find((item) => {
    const plan = asRecord(item);
    return String(plan?.status ?? '').toLowerCase() === 'active';
  });
  const plan = asRecord(active);
  return zcodePlanLabel(plan?.plan_id ?? plan?.name);
}

async function readZcodeCredentials(): Promise<ZcodeAccountCredentials | null> {
  try {
    const root = asRecord(JSON.parse(await readFile(credentialsPath(), 'utf8')));
    const active = decryptZcodeCredential(root?.['oauth:active_provider']);
    if (active !== 'zai' && active !== 'bigmodel') return null;
    const token = decryptZcodeCredential(root?.zcodejwttoken);
    // Each provider stores its platform token under `oauth:<provider>:*`;
    // fall back to the BigModel key for older single-provider layouts.
    const quotaToken = [`oauth:${active}:access_token`, 'oauth:bigmodel:access_token']
      .map((key) => decryptZcodeCredential(root?.[key]))
      .find((value) => typeof value === 'string' && value.length > 20) ?? undefined;
    const primary = token && token.length > 20
      ? token
      : quotaToken && quotaToken.length > 20
        ? quotaToken
        : null;
    if (!primary) return null;
    return {
      token: primary,
      quotaToken,
      provider: active,
    };
  } catch {
    return null;
  }
}

function openCodeHome(): string {
  const configured = process.env.OPENCODE_HOME?.trim();
  if (configured) return expandHome(configured);
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'opencode');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode');
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), '.local', 'share');
  return path.join(xdg, 'opencode');
}

/** Look up a Z.ai / BigModel credential stored in OpenCode's `auth.json`. */
export async function readOpenCodeAuth(): Promise<ZcodeAccountCredentials | null> {
  const authPath = path.join(openCodeHome(), 'auth.json');
  let text: string | null = null;
  try {
    text = await readFile(authPath, 'utf8');
  } catch {
    return null;
  }
  if (text === null) return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(root);
  if (!record) return null;
  // OpenCode stores per-provider credentials under their canonical ids.
  // `zhipuai` is the BigModel-side alias; map it back to `bigmodel` so the
  // existing `quotaUrl()` host routing stays correct.
  for (const [openCodeKey, provider] of [
    ['zai', 'zai'],
    ['zhipuai', 'bigmodel'],
  ] as const) {
    const entry = asRecord(record[openCodeKey]);
    if (!entry) continue;
    const token = typeof entry.token === 'string'
      ? entry.token.trim()
      : typeof entry.apiKey === 'string'
        ? entry.apiKey.trim()
        : typeof entry.api_key === 'string'
          ? entry.api_key.trim()
          : '';
    if (token.length > 20) return { token, provider };
  }
  return null;
}

async function hasBuiltinAccountProvider(provider: ZcodeAccountCredentials['provider']): Promise<boolean> {
  try {
    const root = asRecord(JSON.parse(await readFile(configPath(), 'utf8')));
    const providers = asRecord(root?.provider);
    if (!providers) return false;
    return [...BUILTIN_PROVIDER_IDS].some((id) =>
      id.includes(provider) && asRecord(providers[id])?.enabled === true,
    );
  } catch {
    return false;
  }
}

async function fetchJson(url: string, token: string): Promise<{ status: number; value: unknown }> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, value: response.ok ? await response.json() : null };
}

function quotaUrl(provider: ZcodeAccountCredentials['provider']): string {
  const origin = provider === 'bigmodel' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
  return `${origin}/api/monitor/usage/quota/limit`;
}

async function fetchFreshZcodeSubscription(): Promise<ZcodeSubscriptionSnapshot> {
  const zcodeInstalled = existsSync(zcodeHome());
  let credentials = zcodeInstalled ? await readZcodeCredentials() : null;
  let fromOpenCode = false;
  if (!credentials) {
    credentials = await readOpenCodeAuth();
    fromOpenCode = credentials !== null;
  }
  if (!credentials) {
    return zcodeInstalled
      ? unavailable('not-signed-in', '请先通过 ZCode 账号授权登录')
      : unavailable('not-installed', '未检测到本机 ZCode');
  }
  if (!fromOpenCode && !await hasBuiltinAccountProvider(credentials.provider)) {
    return unavailable('custom-provider', '自定义模型无法获取配额');
  }

  try {
    const [billing, quota] = await Promise.all([
      fetchJson(ZCODE_BILLING_URL, credentials.token),
      fetchJson(quotaUrl(credentials.provider), credentials.quotaToken ?? credentials.token),
    ]);
    // BigModel wraps auth failures in an HTTP 200 body (`code: 401`), so the
    // body-level signal has to participate in the expiry decision.
    const billingAuthFailed =
      billing.status === 401 || billing.status === 403 || zcodeResponseAuthFailed(billing.value);
    const quotaAuthFailed =
      quota.status === 401 || quota.status === 403 || zcodeResponseAuthFailed(quota.value);
    if (billingAuthFailed && quotaAuthFailed) {
      return unavailable('expired', 'ZCode 登录已过期，请重新登录');
    }
    if (billing.status === 429 || quota.status === 429) {
      return staleFallback('ZCode 配额请求过于频繁，请稍后重试');
    }
    const mapped = quota.status >= 200 && quota.status < 300 ? mapZcodeQuota(quota.value) : {
      planLabel: null,
      limits: [],
    };
    if (mapped.limits.length === 0) {
      return staleFallback('ZCode 暂未返回可用的订阅配额');
    }
    const snapshot: ZcodeSubscriptionSnapshot = {
      status: 'ready',
      planLabel: extractBillingPlan(billing.value) ?? mapped.planLabel,
      provider: credentials.provider,
      limits: mapped.limits,
      fetchedAt: Math.floor(Date.now() / 1_000),
      stale: false,
      message: null,
    };
    lastSuccess = snapshot;
    return snapshot;
  } catch {
    return staleFallback('网络异常，暂时无法读取 ZCode 配额');
  }
}

/** Read-only ZCode account subscription lookup; manual API-key mode is excluded. */
export async function readZcodeSubscription(
  options: { forceRefresh?: boolean } = {},
): Promise<ZcodeSubscriptionSnapshot> {
  const cacheAge = lastSuccess?.fetchedAt
    ? Date.now() - lastSuccess.fetchedAt * 1_000
    : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshZcodeSubscription();
  try {
    return await requestInFlight;
  } finally {
    requestInFlight = null;
  }
}

export { extractBillingPlan };

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { mapQoderQuota, type QoderSubscriptionSnapshot } from '../shared/qoder-subscription';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const QODER_API_URL = 'https://openapi.qoder.sh/api/v2';

interface QoderCredentials { token: string; }
let lastSuccess: QoderSubscriptionSnapshot | null = null;
let requestInFlight: Promise<QoderSubscriptionSnapshot> | null = null;

function qoderHome(): string { return path.join(homedir(), '.qoder'); }
function unavailable(status: Exclude<QoderSubscriptionSnapshot['status'], 'ready'>, message: string): QoderSubscriptionSnapshot {
  return { status, planLabel: null, limits: [], fetchedAt: null, stale: false, message };
}
function staleFallback(message: string): QoderSubscriptionSnapshot {
  return lastSuccess ? { ...lastSuccess, stale: true, message } : unavailable('temporarily-unavailable', message);
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Extracts only account-session bearer fields from Qoder's official local auth state. */
export function parseQoderCredentials(value: unknown): QoderCredentials | null {
  const root = asRecord(value);
  if (!root) return null;
  for (const key of ['security_oauth_token', 'access_token', 'accessToken', 'bearerToken', 'token', 'jwtToken']) {
    if (typeof root[key] === 'string' && root[key].trim().length > 20) return { token: root[key].trim() };
  }
  for (const key of ['user', 'auth', 'session', 'data']) {
    const nested = parseQoderCredentials(root[key]);
    if (nested) return nested;
  }
  return null;
}
async function readQoderCredentials(): Promise<QoderCredentials | null> {
  try {
    const content = await readFile(path.join(qoderHome(), '.auth', 'user'), 'utf8');
    try { return parseQoderCredentials(JSON.parse(content)); } catch { return parseQoderCredentials(content); }
  } catch { return null; }
}

interface CachedQoderQuota { value: unknown; fetchedAt: number; }

/**
 * Recent official CLI logs contain the normalized quota response but never need
 * a token to read. This is the safe fallback for Qoder's encrypted auth file.
 */
async function readCachedQoderQuota(): Promise<CachedQoderQuota | null> {
  const runsDirectory = path.join(qoderHome(), 'logs', 'runs');
  if (!existsSync(runsDirectory)) return null;
  let latest: CachedQoderQuota | null = null;
  try {
    for (const entry of readdirSync(runsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const logPath = path.join(runsDirectory, entry.name, 'qodercli.log');
      if (!existsSync(logPath) || statSync(logPath).size > 2_000_000) continue;
      const content = await readFile(logPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const marker = '/api/v2/quota/usage response:';
        const index = line.indexOf(marker);
        if (index < 0) continue;
        try {
          const value = JSON.parse(line.slice(index + marker.length).trim());
          const fetchedAt = Math.floor(statSync(logPath).mtimeMs / 1_000);
          if (!latest || fetchedAt > latest.fetchedAt) latest = { value, fetchedAt };
        } catch { /* Ignore malformed or partially written log lines. */ }
      }
    }
  } catch { return latest; }
  return latest;
}
async function fetchJson(pathname: string, token: string): Promise<{ status: number; value: unknown }> {
  const response = await fetch(`${QODER_API_URL}${pathname}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, value: response.ok ? await response.json() : null };
}
async function fetchFreshQoderSubscription(): Promise<QoderSubscriptionSnapshot> {
  if (!existsSync(qoderHome())) return unavailable('not-installed', '未检测到本机 Qoder');
  const credentials = await readQoderCredentials();
  if (!credentials) {
    const cached = await readCachedQoderQuota();
    const mapped = cached ? mapQoderQuota(cached.value, null) : null;
    if (!cached || !mapped?.limits.length) return unavailable('not-signed-in', '请先登录 Qoder');
    const snapshot: QoderSubscriptionSnapshot = {
      status: 'ready', ...mapped, fetchedAt: cached.fetchedAt, stale: true,
      message: '使用 Qoder CLI 最近同步的额度',
    };
    lastSuccess = snapshot;
    return snapshot;
  }
  try {
    const [plan, quota] = await Promise.all([fetchJson('/user/plan', credentials.token), fetchJson('/quota/usage', credentials.token)]);
    if ((plan.status === 401 || plan.status === 403) && (quota.status === 401 || quota.status === 403)) return unavailable('expired', 'Qoder 登录已过期，请重新登录');
    if (plan.status === 429 || quota.status === 429) return staleFallback('Qoder 配额请求过于频繁，请稍后重试');
    const mapped = quota.status >= 200 && quota.status < 300 ? mapQoderQuota(quota.value, plan.value) : { planLabel: null, limits: [] };
    if (!mapped.limits.length) return staleFallback('Qoder 暂未返回可用的订阅配额');
    const snapshot: QoderSubscriptionSnapshot = { status: 'ready', ...mapped, fetchedAt: Math.floor(Date.now() / 1_000), stale: false, message: null };
    lastSuccess = snapshot;
    return snapshot;
  } catch { return staleFallback('网络异常，暂时无法读取 Qoder 配额'); }
}
/** Read-only Qoder account subscription lookup; BYOK values are never used. */
export async function readQoderSubscription(options: { forceRefresh?: boolean } = {}): Promise<QoderSubscriptionSnapshot> {
  const cacheAge = lastSuccess?.fetchedAt ? Date.now() - lastSuccess.fetchedAt * 1_000 : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && lastSuccess && cacheAge <= CACHE_TTL_MS) return lastSuccess;
  if (requestInFlight) return requestInFlight;
  requestInFlight = fetchFreshQoderSubscription();
  try { return await requestInFlight; } finally { requestInFlight = null; }
}

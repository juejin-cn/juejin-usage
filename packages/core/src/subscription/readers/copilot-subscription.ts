import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { queryDbJson } from '../../parsers/sqlite.js';
import { mapCopilotSubscription, type CopilotSubscriptionSnapshot } from '../shared/copilot-subscription.js';

const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';
const CACHE_TTL_MS = 60_000;

export interface CopilotCredentials {
  user: string;
  tokens: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Only GitHub.com Copilot OAuth sessions; never mix accounts or enterprise hosts. */
export function parseCopilotCredentials(values: unknown[], preferredUser: string | null): CopilotCredentials | null {
  const accounts = new Map<string, string[]>();
  for (const value of values) {
    for (const [host, entry] of Object.entries(asRecord(value) ?? {})) {
      if (host !== 'github.com' && !host.startsWith('github.com:')) continue;
      const account = asRecord(entry);
      const user = typeof account?.user === 'string' ? account.user.trim().toLowerCase() : '';
      const token = typeof account?.oauth_token === 'string' && !/[\r\n]/.test(account.oauth_token)
        ? account.oauth_token.trim() : '';
      if (!user || !token || /[\r\n]/.test(token)) continue;
      const tokens = accounts.get(user) ?? [];
      if (!tokens.includes(token)) tokens.push(token);
      accounts.set(user, tokens);
    }
  }
  const user = preferredUser?.trim().toLowerCase() || (accounts.size === 1 ? accounts.keys().next().value : null);
  const tokens = user ? accounts.get(user) : null;
  return user && tokens?.length ? { user, tokens } : null;
}

function vscodeStatePath(): string {
  const explicit = process.env.VSCODE_STATE_DB_PATH?.trim();
  if (explicit) return explicit.startsWith('~/') ? path.join(homedir(), explicit.slice(2)) : explicit;
  const root = process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(root, 'Code', 'User', 'globalStorage', 'state.vscdb');
}

/** The extension's account-name hint is plaintext metadata, not a VS Code secret. */
export function readCopilotVscodeUser(dbPath: string): string | null {
  try {
    const row = queryDbJson(dbPath, "SELECT value FROM ItemTable WHERE key = 'github.copilot-github' LIMIT 1", { readOnly: true, timeout: 5000, maxBuffer: 1024 * 1024 })[0];
    return typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : null;
  } catch {
    return null;
  }
}

async function readCopilotCredentials(): Promise<CopilotCredentials | null> {
  // These are the explicit token overrides supported by the official language server.
  const token = [process.env.GH_COPILOT_TOKEN, process.env.GITHUB_COPILOT_TOKEN]
    .find((value) => value?.trim() && !value.includes('=') && !/[\r\n]/.test(value))?.trim();
  if (token) return { user: 'environment', tokens: [token] };
  const xdg = process.env.XDG_CONFIG_HOME;
  const root = xdg && path.isAbsolute(xdg) ? xdg
    : process.platform === 'win32'
      ? path.join(process.env.USERPROFILE || homedir(), 'AppData', 'Local')
      : path.join(homedir(), '.config');
  const values: unknown[] = [];
  for (const name of ['apps.json', 'hosts.json']) {
    try {
      values.push(JSON.parse(await readFile(path.join(root, 'github-copilot', name), 'utf8')));
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return parseCopilotCredentials(values, readCopilotVscodeUser(vscodeStatePath()));
}

function unavailable(status: Exclude<CopilotSubscriptionSnapshot['status'], 'ready'>, message: string): CopilotSubscriptionSnapshot {
  return { status, planLabel: null, limits: [], fetchedAt: null, stale: false, message };
}

/** Internal IDE endpoint, also used by VS Code; no credentials leave the main process. */
export async function fetchCopilotSubscription(
  credentials: CopilotCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotSubscriptionSnapshot> {
  for (const token of credentials.tokens) {
    const response = await fetchImpl(COPILOT_USER_URL, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) continue;
    if (!response.ok) throw new Error(`Copilot quota API returned ${response.status}`);
    const mapped = mapCopilotSubscription(await response.json());
    if (!mapped.limits.some((limit) => limit.unlimited || limit.remainingPercent !== null)) {
      throw new Error('Copilot quota response has no supported allowance');
    }
    return { status: 'ready', ...mapped, fetchedAt: Math.floor(Date.now() / 1_000), stale: false, message: null };
  }
  return unavailable('not-signed-in', 'Copilot 登录已过期，请重新登录');
}

/** Cache is scoped to the selected account and session, including in-flight requests. */
export function createCopilotSubscriptionReader(
  loadCredentials: () => Promise<CopilotCredentials | null> = readCopilotCredentials,
  fetchImpl: typeof fetch = fetch,
) {
  let lastSuccess: CopilotSubscriptionSnapshot | null = null;
  let credentialKey: string | null = null;
  let requestInFlight: Promise<CopilotSubscriptionSnapshot> | null = null;

  return async (options: { forceRefresh?: boolean } = {}): Promise<CopilotSubscriptionSnapshot> => {
    let credentials: CopilotCredentials | null;
    try {
      credentials = await loadCredentials();
    } catch {
      lastSuccess = null;
      credentialKey = null;
      requestInFlight = null;
      return unavailable('temporarily-unavailable', '暂时无法读取 Copilot 登录信息');
    }
    const key = credentials ? JSON.stringify(credentials) : null;
    if (key !== credentialKey) {
      lastSuccess = null;
      requestInFlight = null;
      credentialKey = key;
    }
    if (!credentials) return unavailable('not-signed-in', '未找到当前账号的 Copilot 登录信息');
    if (!options.forceRefresh && lastSuccess?.fetchedAt && Date.now() - lastSuccess.fetchedAt * 1_000 <= CACHE_TTL_MS) {
      return lastSuccess;
    }
    if (requestInFlight) return requestInFlight;

    const pending = (async () => {
      try {
        const snapshot = await fetchCopilotSubscription(credentials, fetchImpl);
        if (key !== credentialKey) return unavailable('temporarily-unavailable', 'Copilot 账号已切换，请刷新额度');
        lastSuccess = snapshot.status === 'ready' ? snapshot : null;
        return snapshot;
      } catch {
        const message = '暂时无法读取 Copilot 订阅额度';
        return key === credentialKey && lastSuccess
          ? { ...lastSuccess, stale: true, message }
          : unavailable('temporarily-unavailable', message);
      }
    })();
    requestInFlight = pending;
    try {
      return await pending;
    } finally {
      if (requestInFlight === pending) requestInFlight = null;
    }
  };
}

export const readCopilotSubscription = createCopilotSubscriptionReader();

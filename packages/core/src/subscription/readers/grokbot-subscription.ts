import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { decryptCursorAes128Cbc, decryptCursorWindowsAes256Gcm, loadWindowsOsCryptKeyFromLocalState } from './cursor-safe-storage.js';
import { fetchSubscription } from '../transport.js';
import { mapGrokBotUsage, type GrokBotSubscriptionSnapshot } from '../shared/grokbot-subscription.js';

const execFileAsync = promisify(execFile);
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
const ACCESS = 'cursor-access-token';
const TEAM = 'cursor-selected-team-id';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Never fall back to a different saved account when the user has signed out. */
export function grokBotActiveCredentials(value: unknown): { token: string; team?: string } | null {
  const root = record(value);
  if (root?.version !== 1) throw new Error('Unsupported credential store');
  let account = root;
  if (root['cursor-accounts'] !== undefined) {
    const accounts = record(JSON.parse(String(root['cursor-accounts'])));
    if (!accounts) throw new Error('Invalid account store');
    if (accounts.active === null) return null;
    if (typeof accounts.active !== 'string') throw new Error('Invalid active account');
    const selected = record(record(accounts.accounts)?.[accounts.active]);
    if (!selected) return null;
    account = selected;
  }
  const token = account[ACCESS];
  if (typeof token !== 'string' || !token) return null;
  return { token, ...(typeof account[TEAM] === 'string' ? { team: account[TEAM] } : {}) };
}

function authPath(platform: NodeJS.Platform): string {
  const root = platform === 'darwin' ? path.join(homedir(), 'Library', 'Application Support')
    : platform === 'win32' ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(root, 'Grok Bot', 'sand-secrets.json');
}

interface ReaderOptions {
  authPath?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  decryptString?: (encrypted: Buffer) => Promise<string> | string;
  readKeychainPassword?: () => Promise<string>;
  readWindowsKey?: () => Promise<Buffer>;
}

function unavailable(status: GrokBotSubscriptionSnapshot['status'], message: string): GrokBotSubscriptionSnapshot {
  return { status, planLabel: null, weekly: null, fetchedAt: null, stale: false, message };
}

export function createGrokBotSubscriptionReader(options: ReaderOptions = {}) {
  const platform = options.platform ?? process.platform;
  const file = options.authPath ?? authPath(platform);
  let password: string | undefined;
  let cache: { identity: string; snapshot: GrokBotSubscriptionSnapshot } | undefined;
  let inFlight: { identity: string; promise: Promise<GrokBotSubscriptionSnapshot> } | undefined;
  const readPassword = options.readKeychainPassword ?? (async () => {
    const result = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-s', 'Grok Bot Safe Storage', '-a', 'Grok Bot Key', '-w',
    ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4096 });
    if (!result.stdout.trim()) throw new Error('Missing keychain item');
    return result.stdout.trim();
  });

  async function decode(stored: string, allowPrompt: boolean): Promise<string> {
    if (stored.startsWith('plaintext:v1:')) return Buffer.from(stored.slice(13), 'base64').toString('utf8');
    if (stored.startsWith('scoped:v1:')) {
      const match = /^scoped:v1:[0-9a-f]{64}:(.+)$/.exec(stored);
      if (!match) throw new Error('Invalid credential scope');
      stored = match[1]!;
    }
    const encrypted = Buffer.from(stored, 'base64');
    if (options.decryptString) return options.decryptString(encrypted);
    // Each application's OSCrypt key is separate. Do not use Cursor's cached key.
    if (platform === 'win32') {
      const key = await (options.readWindowsKey?.() ?? loadWindowsOsCryptKeyFromLocalState(path.join(path.dirname(file), 'Local State')));
      try { return decryptCursorWindowsAes256Gcm(encrypted, key); }
      finally { key.fill(0); }
    }
    if (platform !== 'darwin') throw new Error('Unsupported encrypted storage');
    if (!password) {
      if (!allowPrompt) throw new Error('Manual unlock required');
      password = await readPassword();
    }
    if (encrypted.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported ciphertext');
    return decryptCursorAes128Cbc(encrypted, password, 1003);
  }

  return async (request: { forceRefresh?: boolean } = {}): Promise<GrokBotSubscriptionSnapshot> => {
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      cache = undefined;
      return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'unavailable', '请先打开并登录 Grok Bot');
    }
    const identity = createHash('sha256').update(raw).digest('hex');
    if (cache?.identity !== identity) cache = undefined;
    let credentials: ReturnType<typeof grokBotActiveCredentials>;
    try {
      if (raw.length > 1024 * 1024) throw new Error('Credential store too large');
      credentials = grokBotActiveCredentials(JSON.parse(raw));
    } catch { return unavailable('unavailable', '无法识别 Grok Bot 登录信息，请打开客户端后重试'); }
    if (!credentials) return unavailable('not-signed-in', '请先登录 Grok Bot');
    if (!request.forceRefresh && cache && Date.now() - cache.snapshot.fetchedAt! * 1000 < 60_000) return cache.snapshot;
    if (inFlight?.identity === identity) return inFlight.promise;
    cache = undefined;
    const read = async (): Promise<GrokBotSubscriptionSnapshot> => {
      let token: string;
      let team: string | undefined;
      try {
        token = await decode(credentials.token, request.forceRefresh === true);
        if (credentials.team) team = await decode(credentials.team, request.forceRefresh === true);
        if (!token || /[\r\n]/.test(token) || (team && !/^\d+$/.test(team))) throw new Error('Invalid credential');
      } catch {
        password = undefined;
        return unavailable('unavailable', platform === 'darwin'
          ? '点击刷新并允许读取 Grok Bot 登录信息'
          : platform === 'win32' ? '无法解密 Grok Bot 登录信息，请以同一系统用户打开客户端后重试'
            : '当前系统的 Grok Bot 加密登录信息暂不支持读取');
      }
      try {
        const response = await (options.fetch ?? fetchSubscription)(USAGE_URL, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body: '{}',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            'connect-protocol-version': '1', 'x-cursor-client-type': 'sand',
            ...(team ? { 'x-cursor-team-id': team } : {}) },
        });
        if (response.status === 401 || response.status === 403) {
          cache = undefined;
          return unavailable('not-signed-in', 'Grok Bot 登录已失效或没有访问权限，请在客户端确认');
        }
        if (!response.ok) throw new Error('Usage request failed');
        const mapped = mapGrokBotUsage(await response.json());
        if (!mapped.weekly) return unavailable('unavailable', 'Grok Bot 暂未返回可用的个人额度');
        // Do not display another account's result after a switch/sign-out during the request.
        if (await readFile(file, 'utf8') !== raw) return unavailable('unavailable', 'Grok Bot 账号已变化，请刷新');
        const snapshot: GrokBotSubscriptionSnapshot = {
          status: 'ready', ...mapped, fetchedAt: Math.floor(Date.now() / 1000), stale: false, message: null,
        };
        cache = { identity, snapshot };
        return snapshot;
      } catch {
        // Deliberately omit vendor responses, tokens, and keychain error output.
        return unavailable('unavailable', '暂时无法读取 Grok Bot 额度，请检查网络后刷新');
      }
    };
    const promise = read();
    inFlight = { identity, promise };
    try { return await promise; }
    finally { if (inFlight?.promise === promise) inFlight = undefined; }
  };
}

export const readGrokBotSubscription = createGrokBotSubscriptionReader();

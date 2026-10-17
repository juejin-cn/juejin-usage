import { execFile } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KEYCHAIN_PROMPT = '点击刷新并允许读取 Qoder 登录信息';
const KEYCHAIN_UNAVAILABLE = '无法读取 Qoder 登录信息，请允许系统钥匙串访问后重试';

export type QoderAppAuthResult = {
  kind: 'account';
  token: string;
  userId: string;
  expiresAt: number;
  identity: string;
  validateIdentity: () => Promise<boolean>;
} | { kind: 'unavailable'; message: string } | { kind: 'signed-out' } | null;

interface ReadOptions {
  allowKeychainPrompt?: boolean;
  decryptString?: (encrypted: Buffer) => string;
}

interface ReaderOptions {
  platform?: NodeJS.Platform;
  authPath?: string;
  statusPath?: string;
  readKeychainPassword?: () => Promise<string>;
  decryptString?: ReadOptions['decryptString'];
}

function defaultAuthPath(platform: NodeJS.Platform): string {
  const applicationSupport = platform === 'win32'
    ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
    : platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(applicationSupport, 'com.qoder.app.stable', 'auth.v1.dat');
}

async function readMacKeychainPassword(): Promise<string> {
  // The normal keychain access check may ask the user to authorize this process.
  // Qoder App's macOS Electron name differs from the older Qoder IDE's name.
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password', '-s', 'Qoder App Safe Storage', '-a', 'Qoder App Key', '-w',
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4096 });
  const password = stdout.trim();
  if (!password) throw new Error('Qoder keychain item is empty');
  return password;
}

function decryptMacAuth(encrypted: Buffer, password: string): string {
  if (encrypted.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported Qoder storage format');
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString('utf8');
  } finally { key.fill(0); }
}

function parseAccount(value: unknown): { token: string; userId: string; expiresAt: number } | null {
  if (!value || typeof value !== 'object') return null;
  const auth = value as Record<string, unknown>;
  const user = auth.user && typeof auth.user === 'object' ? auth.user as Record<string, unknown> : null;
  if (auth.schemaVersion !== 1 || typeof auth.token !== 'string' || !auth.token.trim() || /[\r\n]/.test(auth.token)
    || typeof user?.id !== 'string' || !user.id.trim()
    || typeof auth.expiresAt !== 'string' || !Number.isFinite(Date.parse(auth.expiresAt))) return null;
  return { token: auth.token, userId: user.id, expiresAt: Date.parse(auth.expiresAt) };
}

/** Reads official App credentials without modifying its session or refreshing its token. */
export function createQoderAppAuthReader(options: ReaderOptions = {}) {
  const platform = options.platform ?? process.platform;
  const authPath = options.authPath ?? defaultAuthPath(platform);
  const statusPath = options.statusPath ?? path.join(homedir(), '.qoder', '.qoder-app-status.json');
  let cachedPassword: string | null = null;
  let passwordInFlight: Promise<string> | null = null;

  async function loginStatus(): Promise<boolean | null> {
    try {
      const value: unknown = JSON.parse(await readFile(statusPath, 'utf8'));
      if (!value || typeof value !== 'object') return null;
      const status = value as Record<string, unknown>;
      const loggedIn = status.logged_in ?? status.loggedIn;
      return typeof loggedIn === 'boolean' ? loggedIn : null;
    } catch { return null; }
  }

  async function encryptedState(): Promise<{ encrypted: Buffer; identity: string } | null> {
    try {
      const before = await stat(authPath);
      if (!before.isFile() || before.size > 1_048_576) throw new Error('Invalid Qoder auth file');
      const encrypted = await readFile(authPath);
      const after = await stat(authPath);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('Qoder auth file changed during read');
      }
      const identity = createHash('sha256').update(encrypted)
        .update(`:${after.ino}:${after.mtimeMs}`).digest('hex');
      return { encrypted, identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function validateIdentity(identity: string): Promise<boolean> {
    try {
      if (await loginStatus() !== true) {
        cachedPassword = null;
        return false;
      }
      const current = await encryptedState();
      const signedIn = await loginStatus() === true;
      if (!signedIn) cachedPassword = null;
      return current?.identity === identity && signedIn;
    } catch { return false; }
  }

  return async function read(readOptions: ReadOptions = {}): Promise<QoderAppAuthResult> {
    const status = await loginStatus();
    if (status === false) {
      cachedPassword = null;
      return { kind: 'signed-out' };
    }

    let state: Awaited<ReturnType<typeof encryptedState>>;
    try { state = await encryptedState(); }
    catch { return { kind: 'unavailable', message: '无法读取 Qoder 登录文件，请打开 Qoder 后重试' }; }
    if (!state) return status === true
      ? { kind: 'unavailable', message: '已登录 Qoder，但暂时无法读取登录信息' }
      : null;
    if (status !== true) return { kind: 'unavailable', message: '无法确认 Qoder 登录状态，请打开 Qoder 并登录后刷新' };

    let plaintext: string;
    if (platform === 'darwin') {
      if (!cachedPassword) {
        if (!readOptions.allowKeychainPrompt) return { kind: 'unavailable', message: KEYCHAIN_PROMPT };
        try {
          passwordInFlight ??= (options.readKeychainPassword ?? readMacKeychainPassword)();
          cachedPassword = await passwordInFlight;
          if (!cachedPassword) throw new Error('Empty Qoder keychain password');
        } catch {
          cachedPassword = null;
          return { kind: 'unavailable', message: KEYCHAIN_UNAVAILABLE };
        } finally { passwordInFlight = null; }
      }
      try { plaintext = decryptMacAuth(state.encrypted, cachedPassword); }
      catch {
        cachedPassword = null;
        return { kind: 'unavailable', message: '无法解密 Qoder 登录信息，请打开 Qoder 并刷新后重试' };
      }
    } else if (platform === 'win32') {
      const decryptString = readOptions.decryptString ?? options.decryptString;
      if (!decryptString) return { kind: 'unavailable', message: '当前环境无法读取 Qoder 的系统加密登录信息' };
      try { plaintext = decryptString(state.encrypted); }
      catch { return { kind: 'unavailable', message: '无法解密 Qoder 登录信息，请打开 Qoder 并刷新后重试' }; }
    } else {
      return { kind: 'unavailable', message: '当前系统暂不支持读取 Qoder App 的加密登录信息' };
    }

    let account: ReturnType<typeof parseAccount>;
    try { account = parseAccount(JSON.parse(plaintext)); }
    catch { account = null; }
    if (!account) return { kind: 'unavailable', message: 'Qoder 登录信息格式暂不支持，请更新 Qoder 后重试' };
    if (!await validateIdentity(state.identity)) {
      cachedPassword = null;
      return { kind: 'unavailable', message: 'Qoder 登录状态已变化，请刷新重试' };
    }
    return { kind: 'account', ...account, identity: state.identity, validateIdentity: () => validateIdentity(state.identity) };
  };
}

export const readQoderAppAuth = createQoderAppAuthReader();

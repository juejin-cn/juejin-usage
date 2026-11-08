import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Cursor wraps Electron/Chromium safeStorage ciphertext with this prefix in state.vscdb. */
export const CURSOR_SAFE_STORAGE_PREFIX = 'cursor-safe-storage:v1:';

const KEYCHAIN_SERVICE = 'Cursor Safe Storage';
const KEYCHAIN_ACCOUNT = 'Cursor Key';
const PBKDF2_SALT = 'saltysalt';
const MAC_PBKDF2_ITERATIONS = 1003;
const LINUX_PBKDF2_ITERATIONS = 1;
const PBKDF2_KEY_LENGTH = 16;
const V10_PREFIX = 'v10';
const V11_PREFIX = 'v11';
const LINUX_BASIC_PASSWORD = 'peanuts';
const LINUX_OSCRYPT_V2_SCHEMA = 'chrome_libsecret_os_crypt_password_v2';
const WIN_KEY_LENGTH = 32;
const WIN_NONCE_LENGTH = 12;
const WIN_TAG_LENGTH = 16;
const DPAPI_PREFIX = 'DPAPI';

export type CursorSafeStorageErrorKind =
  | 'unsupported-platform'
  | 'keychain-required'
  | 'keychain-denied'
  | 'decrypt-failed'
  | 'malformed';

export class CursorSafeStorageError extends Error {
  constructor(readonly kind: CursorSafeStorageErrorKind, message: string) {
    super(message);
    this.name = 'CursorSafeStorageError';
  }
}

const KEYCHAIN_PROMPT = '点击刷新并允许钥匙串访问（建议选「始终允许」）';
const KEYCHAIN_DENIED = '无法读取 Cursor 登录信息，请点刷新并在钥匙串弹窗选择「始终允许」';
const LINUX_KEYRING_PROMPT = '点击刷新并允许解锁钥匙环（如有弹窗）';
const LINUX_KEYRING_DENIED = '无法读取 Cursor 登录信息，请点刷新并在钥匙环弹窗中授权';
const DECRYPT_FAILED = '无法解密 Cursor 登录信息，请打开 Cursor 后重试';
const WINDOWS_DECRYPT_FAILED = '无法解密 Cursor 登录信息，请确认已用同一 Windows 用户打开过 Cursor';

export interface CursorSafeStorageOptions {
  platform?: NodeJS.Platform;
  /**
   * Full override decryptor (tests / rare injectors). Receives raw Chromium
   * safeStorage ciphertext (`v10`/`v11`…) and must return UTF-8 plaintext.
   * When set, platform-specific OSCrypt paths are skipped.
   */
  decryptString?: (encrypted: Buffer) => string;
  readKeychainPassword?: () => Promise<string>;
  /** Injected Windows OSCrypt AES-256 key (32 bytes); skips Local State + DPAPI. */
  readWindowsOsCryptKey?: () => Promise<Buffer>;
  /** Injected Linux master password; skips secret-tool / peanuts discovery. */
  readLinuxPassword?: () => Promise<string>;
  /** Override path to Cursor `Local State` (Windows OSCrypt key). */
  localStatePath?: string;
  /**
   * When false/omitted, never invoke Keychain / Secret Service if the password
   * is not already cached — used by background CSV sync and card auto open/focus.
   * Manual refresh passes true so the system dialog appears only on user action.
   * Windows DPAPI and Linux `peanuts` (v10 basic) do not require this flag.
   */
  allowKeychainPrompt?: boolean;
  /** Drop any cached OSCrypt material before reading (manual refresh). */
  forceKeychainRefresh?: boolean;
}

let cachedKeychainPassword: string | null = null;
let keychainInFlight: Promise<string> | null = null;
/** After the user denies Keychain access, skip auto prompts until a manual refresh. */
let keychainDeniedThisSession = false;

let cachedWindowsKey: Buffer | null = null;
let windowsKeyInFlight: Promise<Buffer> | null = null;

let cachedLinuxPassword: string | null = null;
let linuxPasswordInFlight: Promise<string> | null = null;
let linuxKeyringDeniedThisSession = false;

/**
 * Host-owned copy of the macOS `Cursor Safe Storage` password, sealed with an
 * item the host app owns (Desktop: Electron safeStorage) so reading it never
 * raises Cursor's Keychain dialog.
 */
export interface CursorKeychainPasswordStore {
  load(): Promise<string | null>;
  save(password: string): Promise<void>;
  clear(): Promise<void>;
}

let keychainPasswordStore: CursorKeychainPasswordStore | null = null;

export function configureCursorKeychainPasswordStore(store: CursorKeychainPasswordStore | null): void {
  keychainPasswordStore = store;
}

/** Test seam / process shutdown. Does not touch the configured password store. */
export function resetCursorSafeStorageCache(): void {
  cachedKeychainPassword = null;
  keychainInFlight = null;
  keychainDeniedThisSession = false;
  if (cachedWindowsKey) cachedWindowsKey.fill(0);
  cachedWindowsKey = null;
  windowsKeyInFlight = null;
  cachedLinuxPassword = null;
  linuxPasswordInFlight = null;
  linuxKeyringDeniedThisSession = false;
}

/** True after a Keychain denial in this process; subscription auto-loads should not re-prompt. */
export function isCursorKeychainDenied(): boolean {
  return keychainDeniedThisSession || linuxKeyringDeniedThisSession;
}

function saveStoredKeychainPassword(password: string): void {
  void keychainPasswordStore?.save(password).catch(() => {});
}

function clearStoredKeychainPassword(): void {
  void keychainPasswordStore?.clear().catch(() => {});
}

/** Decrypt with the host-stored password; a stale copy is cleared and yields null. */
async function decryptWithStoredKeychainPassword(ciphertext: Buffer): Promise<string | null> {
  if (!keychainPasswordStore) return null;
  const stored = await keychainPasswordStore.load().catch(() => null);
  if (!stored) return null;
  try {
    const plain = decryptCursorAes128Cbc(ciphertext, stored, MAC_PBKDF2_ITERATIONS);
    if (!isPlainCursorAccessToken(plain.trim())) throw new Error('not a JWT');
    cachedKeychainPassword = stored;
    keychainDeniedThisSession = false;
    return plain;
  } catch {
    clearStoredKeychainPassword();
    return null;
  }
}
export function isSealedCursorAccessToken(value: string): boolean {
  return value.startsWith(CURSOR_SAFE_STORAGE_PREFIX);
}

/** True for a three-segment JWT that older Cursor builds stored in plaintext. */
export function isPlainCursorAccessToken(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export function decodeSealedCursorCiphertext(value: string): Buffer {
  if (!isSealedCursorAccessToken(value)) {
    throw new CursorSafeStorageError('malformed', 'Cursor access token is not sealed');
  }
  const encoded = value.slice(CURSOR_SAFE_STORAGE_PREFIX.length).trim();
  if (!encoded) throw new CursorSafeStorageError('malformed', 'Cursor sealed token is empty');
  const ciphertext = Buffer.from(encoded, 'base64');
  if (ciphertext.length < 4) {
    throw new CursorSafeStorageError('malformed', 'Cursor sealed token ciphertext is truncated');
  }
  return ciphertext;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

/** Cursor Electron `Local State` (holds Windows `os_crypt.encrypted_key`). */
export function cursorLocalStatePath(platform: NodeJS.Platform = process.platform): string {
  const explicit = process.env.CURSOR_LOCAL_STATE_PATH?.trim();
  if (explicit) return expandHome(explicit);
  if (platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Cursor', 'Local State');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'Local State');
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), '.config');
  return path.join(expandHome(xdg), 'Cursor', 'Local State');
}

/** Chromium/Electron os_crypt key derivation (macOS=1003 iters, Linux=1). */
export function deriveCursorOsCryptKey(
  keychainPassword: string,
  iterations: number = MAC_PBKDF2_ITERATIONS,
): Buffer {
  return pbkdf2Sync(keychainPassword, PBKDF2_SALT, iterations, PBKDF2_KEY_LENGTH, 'sha1');
}

function cipherPrefix(ciphertext: Buffer): 'v10' | 'v11' | null {
  const head3 = ciphertext.subarray(0, 3).toString('utf8');
  if (head3 === V10_PREFIX) return 'v10';
  if (head3 === V11_PREFIX) return 'v11';
  return null;
}

/**
 * Decrypt Chromium AES-128-CBC ciphertext (`v10`/`v11`).
 * Some Electron builds store a raw 16-byte key as base64 in Keychain; try PBKDF2
 * first, then that direct key.
 */
export function decryptCursorAes128Cbc(
  ciphertext: Buffer,
  keychainPassword: string,
  iterations: number = MAC_PBKDF2_ITERATIONS,
): string {
  const prefix = cipherPrefix(ciphertext);
  if (!prefix) {
    throw new CursorSafeStorageError('malformed', 'Unsupported Cursor storage format');
  }
  const body = ciphertext.subarray(prefix.length);
  const iv = Buffer.alloc(16, 0x20);
  const attempts: Buffer[] = [deriveCursorOsCryptKey(keychainPassword, iterations)];
  try {
    const raw = Buffer.from(keychainPassword, 'base64');
    if (raw.length === PBKDF2_KEY_LENGTH) attempts.push(raw);
  } catch {
    // Ignore invalid base64; PBKDF2 path remains.
  }

  let lastError: unknown;
  for (const key of attempts) {
    try {
      const decipher = createDecipheriv('aes-128-cbc', key, iv);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      if (!plain.trim()) throw new Error('empty plaintext');
      return plain;
    } catch (error) {
      lastError = error;
    } finally {
      key.fill(0);
    }
  }
  throw new CursorSafeStorageError(
    'decrypt-failed',
    lastError instanceof Error ? lastError.message : 'Unable to decrypt Cursor access token',
  );
}

/** @deprecated Prefer {@link decryptCursorAes128Cbc}; kept for existing imports. */
export function decryptCursorV10Ciphertext(ciphertext: Buffer, keychainPassword: string): string {
  return decryptCursorAes128Cbc(ciphertext, keychainPassword, MAC_PBKDF2_ITERATIONS);
}

/** Chromium Windows OSCrypt: `v10` + AES-256-GCM (nonce 12 + ciphertext + tag 16). */
export function decryptCursorWindowsAes256Gcm(ciphertext: Buffer, key32: Buffer): string {
  if (cipherPrefix(ciphertext) !== 'v10') {
    throw new CursorSafeStorageError('malformed', 'Unsupported Cursor Windows storage format');
  }
  if (key32.length !== WIN_KEY_LENGTH) {
    throw new CursorSafeStorageError('malformed', 'Windows OSCrypt key must be 32 bytes');
  }
  if (ciphertext.length < V10_PREFIX.length + WIN_NONCE_LENGTH + WIN_TAG_LENGTH) {
    throw new CursorSafeStorageError('malformed', 'Cursor Windows ciphertext is truncated');
  }
  const nonce = ciphertext.subarray(V10_PREFIX.length, V10_PREFIX.length + WIN_NONCE_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - WIN_TAG_LENGTH);
  const body = ciphertext.subarray(
    V10_PREFIX.length + WIN_NONCE_LENGTH,
    ciphertext.length - WIN_TAG_LENGTH,
  );
  try {
    const decipher = createDecipheriv('aes-256-gcm', key32, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    if (!plain.trim()) throw new Error('empty plaintext');
    return plain;
  } catch (error) {
    throw new CursorSafeStorageError(
      'decrypt-failed',
      error instanceof Error ? error.message : 'Unable to decrypt Cursor Windows access token',
    );
  }
}

/** Build a sealed token for unit tests (macOS os_crypt v10 scheme). */
export function sealCursorAccessTokenForTests(plaintext: string, keychainPassword: string): string {
  const key = deriveCursorOsCryptKey(keychainPassword, MAC_PBKDF2_ITERATIONS);
  try {
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const ciphertext = Buffer.concat([
      Buffer.from(V10_PREFIX),
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    return `${CURSOR_SAFE_STORAGE_PREFIX}${ciphertext.toString('base64')}`;
  } finally {
    key.fill(0);
  }
}

/** Build a sealed Windows AES-256-GCM token for unit tests. */
export function sealCursorAccessTokenWindowsForTests(plaintext: string, key32: Buffer): string {
  if (key32.length !== WIN_KEY_LENGTH) throw new Error('Windows test key must be 32 bytes');
  const nonce = randomBytes(WIN_NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key32, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([Buffer.from(V10_PREFIX), nonce, encrypted, tag]);
  return `${CURSOR_SAFE_STORAGE_PREFIX}${ciphertext.toString('base64')}`;
}

/** Build a sealed Linux AES-128-CBC token (`v10` peanuts / `v11` keyring) for unit tests. */
export function sealCursorAccessTokenLinuxForTests(
  plaintext: string,
  password: string,
  prefix: 'v10' | 'v11' = 'v10',
): string {
  const key = deriveCursorOsCryptKey(password, LINUX_PBKDF2_ITERATIONS);
  try {
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const ciphertext = Buffer.concat([
      Buffer.from(prefix),
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    return `${CURSOR_SAFE_STORAGE_PREFIX}${ciphertext.toString('base64')}`;
  } finally {
    key.fill(0);
  }
}

async function readMacKeychainPassword(): Promise<string> {
  // Do not use osascript/System Events to raise SecurityAgent: that triggers a
  // separate Automation permission dialog for "Juejin Usage" controlling System Events.
  const { stdout } = await execFileAsync(
    '/usr/bin/security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 4096 },
  );
  const password = stdout.trim();
  if (!password) throw new Error('Cursor keychain item is empty');
  return password;
}

async function dpapiUnprotectBuffer(blob: Buffer): Promise<Buffer> {
  const b64 = blob.toString('base64');
  // Embed only base64 so the PowerShell snippet stays free of binary injection.
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    '$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($dec)',
  ].join(';');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true },
  );
  const out = stdout.replace(/\r?\n/g, '').trim();
  if (!out) throw new Error('DPAPI returned empty key');
  return Buffer.from(out, 'base64');
}

export async function loadWindowsOsCryptKeyFromLocalState(
  localStatePath: string,
  unprotect: (blob: Buffer) => Promise<Buffer> = dpapiUnprotectBuffer,
): Promise<Buffer> {
  let raw: string;
  try {
    raw = await readFile(localStatePath, 'utf8');
  } catch {
    throw new CursorSafeStorageError(
      'decrypt-failed',
      '找不到 Cursor Local State，请先打开一次 Cursor',
    );
  }
  let parsed: { os_crypt?: { encrypted_key?: unknown } };
  try {
    parsed = JSON.parse(raw) as { os_crypt?: { encrypted_key?: unknown } };
  } catch {
    throw new CursorSafeStorageError('malformed', 'Cursor Local State 不是有效 JSON');
  }
  const encKeyB64 = parsed.os_crypt?.encrypted_key;
  if (typeof encKeyB64 !== 'string' || !encKeyB64) {
    throw new CursorSafeStorageError(
      'decrypt-failed',
      'Cursor Local State 缺少加密密钥，请打开一次 Cursor 后重试',
    );
  }
  const encKey = Buffer.from(encKeyB64, 'base64');
  if (encKey.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
    throw new CursorSafeStorageError(
      'unsupported-platform',
      'Cursor 启用了无法在本机解密的 App-Bound 加密',
    );
  }
  const key = await unprotect(encKey.subarray(DPAPI_PREFIX.length));
  if (key.length !== WIN_KEY_LENGTH) {
    key.fill(0);
    throw new CursorSafeStorageError('decrypt-failed', WINDOWS_DECRYPT_FAILED);
  }
  return key;
}

async function secretToolLookup(attrs: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', ...attrs], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4096,
    });
    return stdout.replace(/\n$/, '');
  } catch {
    return '';
  }
}

async function readLinuxMasterPassword(): Promise<string> {
  for (const application of ['cursor', 'Cursor']) {
    const fromSchema = await secretToolLookup([
      'xdg:schema',
      LINUX_OSCRYPT_V2_SCHEMA,
      'application',
      application,
    ]);
    if (fromSchema) return fromSchema;
  }
  const legacy = await secretToolLookup([
    'service',
    KEYCHAIN_SERVICE,
    'account',
    'Cursor',
  ]);
  if (legacy) return legacy;
  return '';
}

async function resolveWindowsKey(options: CursorSafeStorageOptions): Promise<Buffer> {
  if (options.forceKeychainRefresh) {
    if (cachedWindowsKey) cachedWindowsKey.fill(0);
    cachedWindowsKey = null;
  }
  if (cachedWindowsKey) return cachedWindowsKey;
  try {
    windowsKeyInFlight ??= (options.readWindowsOsCryptKey
      ?? (() => loadWindowsOsCryptKeyFromLocalState(
        options.localStatePath ?? cursorLocalStatePath('win32'),
      )))();
    const key = await windowsKeyInFlight;
    if (!key || key.length !== WIN_KEY_LENGTH) throw new Error('invalid Windows OSCrypt key');
    cachedWindowsKey = Buffer.from(key);
    return cachedWindowsKey;
  } catch (error) {
    if (cachedWindowsKey) cachedWindowsKey.fill(0);
    cachedWindowsKey = null;
    if (error instanceof CursorSafeStorageError) throw error;
    throw new CursorSafeStorageError('decrypt-failed', WINDOWS_DECRYPT_FAILED);
  } finally {
    windowsKeyInFlight = null;
  }
}

async function resolveLinuxKeyringPassword(options: CursorSafeStorageOptions): Promise<string> {
  if (options.forceKeychainRefresh) {
    cachedLinuxPassword = null;
    linuxKeyringDeniedThisSession = false;
  }
  if (cachedLinuxPassword) return cachedLinuxPassword;

  if (!options.allowKeychainPrompt) {
    throw new CursorSafeStorageError(
      linuxKeyringDeniedThisSession ? 'keychain-denied' : 'keychain-required',
      linuxKeyringDeniedThisSession ? LINUX_KEYRING_DENIED : LINUX_KEYRING_PROMPT,
    );
  }

  try {
    linuxPasswordInFlight ??= (options.readLinuxPassword ?? readLinuxMasterPassword)();
    const password = await linuxPasswordInFlight;
    if (!password) throw new Error('Cursor linux keyring item is empty');
    cachedLinuxPassword = password;
    linuxKeyringDeniedThisSession = false;
    return cachedLinuxPassword;
  } catch (error) {
    if (error instanceof CursorSafeStorageError) throw error;
    linuxKeyringDeniedThisSession = true;
    throw new CursorSafeStorageError('keychain-denied', LINUX_KEYRING_DENIED);
  } finally {
    linuxPasswordInFlight = null;
  }
}

/**
 * Resolve a Cursor accessToken cell to a usable JWT.
 * Plaintext JWTs from older builds pass through unchanged.
 */
export async function unwrapCursorAccessToken(
  value: string,
  options: CursorSafeStorageOptions = {},
): Promise<string> {
  const trimmed = value.trim();
  if (!trimmed) throw new CursorSafeStorageError('malformed', 'Cursor access token is empty');
  if (!isSealedCursorAccessToken(trimmed)) {
    if (isPlainCursorAccessToken(trimmed)) return trimmed;
    throw new CursorSafeStorageError('malformed', 'Cursor access token format is unsupported');
  }

  const platform = options.platform ?? process.platform;
  const ciphertext = decodeSealedCursorCiphertext(trimmed);

  if (options.decryptString) {
    try {
      const plain = options.decryptString(ciphertext).trim();
      if (!plain) throw new Error('empty plaintext');
      return plain;
    } catch {
      throw new CursorSafeStorageError('decrypt-failed', DECRYPT_FAILED);
    }
  }

  if (platform === 'darwin') {
    if (options.forceKeychainRefresh) {
      cachedKeychainPassword = null;
      keychainDeniedThisSession = false;
    }
    let readFromKeychain = false;
    if (!cachedKeychainPassword) {
      const fromStore = await decryptWithStoredKeychainPassword(ciphertext);
      if (fromStore) return fromStore;
      // Auto open/focus and CSV sync pass allowKeychainPrompt:false.
      // Manual refresh passes true; in-process cache still serves later auto loads.
      if (!options.allowKeychainPrompt) {
        throw new CursorSafeStorageError(
          keychainDeniedThisSession ? 'keychain-denied' : 'keychain-required',
          keychainDeniedThisSession ? KEYCHAIN_DENIED : KEYCHAIN_PROMPT,
        );
      }
      try {
        keychainInFlight ??= (options.readKeychainPassword ?? readMacKeychainPassword)();
        cachedKeychainPassword = await keychainInFlight;
        if (!cachedKeychainPassword) throw new Error('Empty Cursor keychain password');
        keychainDeniedThisSession = false;
        readFromKeychain = true;
      } catch (error) {
        if (error instanceof CursorSafeStorageError) throw error;
        cachedKeychainPassword = null;
        keychainDeniedThisSession = true;
        throw new CursorSafeStorageError('keychain-denied', KEYCHAIN_DENIED);
      } finally {
        keychainInFlight = null;
      }
    }
    try {
      const plain = decryptCursorAes128Cbc(ciphertext, cachedKeychainPassword, MAC_PBKDF2_ITERATIONS);
      if (readFromKeychain) saveStoredKeychainPassword(cachedKeychainPassword);
      return plain;
    } catch (error) {
      cachedKeychainPassword = null;
      if (error instanceof CursorSafeStorageError) throw error;
      throw new CursorSafeStorageError('decrypt-failed', DECRYPT_FAILED);
    }
  }

  if (platform === 'win32') {
    const key = await resolveWindowsKey(options);
    try {
      return decryptCursorWindowsAes256Gcm(ciphertext, key);
    } catch (error) {
      if (cachedWindowsKey) cachedWindowsKey.fill(0);
      cachedWindowsKey = null;
      if (error instanceof CursorSafeStorageError) {
        if (error.kind === 'decrypt-failed') {
          throw new CursorSafeStorageError('decrypt-failed', WINDOWS_DECRYPT_FAILED);
        }
        throw error;
      }
      throw new CursorSafeStorageError('decrypt-failed', WINDOWS_DECRYPT_FAILED);
    }
  }

  if (platform === 'linux') {
    const prefix = cipherPrefix(ciphertext);
    if (!prefix) {
      throw new CursorSafeStorageError('malformed', 'Unsupported Cursor storage format');
    }

    // v10 basic_text (peanuts) needs no keyring prompt. Prefer it first so
    // background CSV sync works on headless / no-libsecret installs.
    if (prefix === 'v10') {
      try {
        return decryptCursorAes128Cbc(ciphertext, LINUX_BASIC_PASSWORD, LINUX_PBKDF2_ITERATIONS);
      } catch {
        // Fall through to keyring password (or injected reader).
      }
    }

    const password = await resolveLinuxKeyringPassword(options);
    try {
      return decryptCursorAes128Cbc(ciphertext, password, LINUX_PBKDF2_ITERATIONS);
    } catch (error) {
      cachedLinuxPassword = null;
      if (error instanceof CursorSafeStorageError) throw error;
      throw new CursorSafeStorageError('decrypt-failed', DECRYPT_FAILED);
    }
  }

  throw new CursorSafeStorageError(
    'unsupported-platform',
    '当前系统暂不支持读取 Cursor 的加密登录信息',
  );
}

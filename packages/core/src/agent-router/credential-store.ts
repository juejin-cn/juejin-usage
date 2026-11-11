import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validSubscriptionAuth } from './subscription-auth.js';
import { RouterError, type RouterProvider } from './config.js';

export type VaultDocument = { kind: 'document'; data: Record<string, unknown> };
export type SavedCredential = { kind: 'api'; key: string } | { kind: 'oauth'; access: string; refresh?: string; expiresAt: number } | { kind: 'subscription'; auth: Record<string, unknown> };
// Bind credentials to the destination and auth configuration, not a mutable display name.
export function credentialIdentity(p: RouterProvider): string {
  return createHash('sha256').update(JSON.stringify([p.id, p.baseUrl, p.protocol, p.auth])).digest('hex');
}
export function validApiKey(key: unknown): key is string { return typeof key === 'string' && key.trim().length > 0 && key.length <= 16384 && !/[\x00-\x20\x7f]/.test(key); }
function valid(value: unknown): value is SavedCredential | VaultDocument {
  if (!value || typeof value !== 'object') return false;
  if ((value as VaultDocument).kind === 'document') {
    const data = (value as VaultDocument).data; return !!data && typeof data === 'object' && !Array.isArray(data);
  }
  const c = value as SavedCredential;
  if (c.kind === 'api') return validApiKey(c.key);
  if (c.kind === 'oauth') return validApiKey(c.access) && Number.isFinite(c.expiresAt) && (c.refresh === undefined || validApiKey(c.refresh));
  return c.kind === 'subscription' && validSubscriptionAuth(c.auth);
}

/** Authenticated encrypted vault. The wrapping key is supplied by the desktop host (local data-dir file). */
export class RouterCredentialStore {
  private entries: Record<string, SavedCredential | VaultDocument> = {};
  private queue = Promise.resolve();
  private loaded = false;
  error: string | null = null;
  private readonly key?: Buffer;
  constructor(private path: string, key?: Uint8Array) {
    if (key?.length === 32) this.key = Buffer.from(key);
  }
  private aad(): Buffer { return Buffer.from('jusage-gateway-vault-v1:' + resolve(this.path)); }
  private async directory(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const info = await lstat(dirname(this.path));
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error();
    if (process.platform === 'win32') return;
    const dir = await open(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await dir.chmod(0o700); } finally { await dir.close(); }
  }
  async gatewayToken(rotate = false): Promise<string> {
    const id = createHash('sha256').update('gateway-access-token-v1').digest('hex');
    const saved = this.entries[id];
    if (!rotate && saved?.kind === 'api') return saved.key;
    const token = `sk-${randomBytes(32).toString('base64url')}`;
    await this.change(id, { kind: 'api', key: token }); return token;
  }
  async init(): Promise<void> {
    if (!this.key) { this.error = 'SECURE_STORAGE_UNAVAILABLE'; return; }
    try {
      await this.directory();
      if ((await lstat(this.path)).isSymbolicLink()) throw new Error();
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile() || (await file.stat()).size > 4 * 1024 * 1024) throw new Error();
        const info = await file.stat();
        if (process.getuid && info.uid !== process.getuid()) throw new Error();
        const envelope = JSON.parse(await file.readFile('utf8'));
        if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') throw new Error();
        const iv = Buffer.from(envelope.iv, 'base64'); const tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(this.aad()); cipher.setAuthTag(tag);
        const data = JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
        if (data.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries) || Object.entries(data.entries).some(([k, v]) => !/^[a-f0-9]{64}$/.test(k) || !valid(v))) throw new Error();
        await file.chmod(0o600); this.entries = data.entries;
      } finally { await file.close(); }
      this.loaded = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.loaded = true;
      else this.error = 'CREDENTIAL_STORE_UNREADABLE';
    }
  }
  get(provider: RouterProvider): SavedCredential | undefined {
    const value = this.entries[credentialIdentity(provider)]; return value && value.kind !== 'document' ? structuredClone(value) : undefined;
  }
  set(provider: RouterProvider, value: SavedCredential): Promise<void> {
    if (!valid(value)) return Promise.reject(new RouterError('CREDENTIAL_INVALID'));
    return this.change(credentialIdentity(provider), structuredClone(value));
  }
  delete(provider: RouterProvider): Promise<void> { return this.change(credentialIdentity(provider)); }
  getDocument<T extends Record<string, unknown>>(name: string): T | undefined {
    const value = this.entries[createHash('sha256').update('document:' + name).digest('hex')];
    return value?.kind === 'document' ? structuredClone(value.data) as T : undefined;
  }
  setDocument(name: string, data: Record<string, unknown>): Promise<void> {
    return this.change(createHash('sha256').update('document:' + name).digest('hex'), { kind: 'document', data: structuredClone(data) });
  }
  private change(key: string, value?: SavedCredential | VaultDocument): Promise<void> {
    const next = this.queue.then(async () => {
      if (!this.loaded || !this.key) throw new RouterError(this.error ?? 'CREDENTIAL_STORE_UNREADABLE', 503);
      const entries = { ...this.entries }; if (value) entries[key] = value; else delete entries[key];
      const raw = JSON.stringify({ version: 1, entries });
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new RouterError('CREDENTIAL_STORE_FULL', 503);
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(this.aad());
      const ciphertext = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
      const encrypted = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      const temp = this.path + '.' + randomUUID() + '.tmp';
      try {
        await this.directory();
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.path); this.entries = entries; this.error = null;
      } catch { this.error = 'CREDENTIAL_SAVE_FAILED'; throw new RouterError(this.error, 503); }
      finally { await unlink(temp).catch(() => {}); }
    });
    this.queue = next.catch(() => {}); return next;
  }
  async flush(): Promise<void> { await this.queue; }
}


/** Match authenticated subjects, never a mutable display name. */
export function sameSubscriptionAccount(provider: RouterProvider, left: SavedCredential, other: RouterProvider, right: SavedCredential): boolean {
  if (provider.auth.kind !== 'subscription' || other.auth.kind !== 'subscription'
    || provider.auth.provider !== other.auth.provider || provider.protocol !== other.protocol
    || left.kind !== 'subscription' || right.kind !== 'subscription'
    || left.auth.type !== 'oauth' || right.auth.type !== 'oauth') return false;
  if (provider.auth.provider === 'codex') {
    return typeof left.auth.accountId === 'string' && !!left.auth.accountId && left.auth.accountId === right.auth.accountId;
  }
  if (provider.auth.provider === 'claude' && left.auth.source === 'claude-code-local' && right.auth.source === 'claude-code-local') {
    return typeof left.auth.accountName === 'string' && !!left.auth.accountName && left.auth.accountName === right.auth.accountName
      && (left.auth.organizationId ?? '') === (right.auth.organizationId ?? '');
  }
  if (typeof left.auth.uid === 'string' && left.auth.uid && typeof right.auth.uid === 'string') {
    return left.auth.uid === right.auth.uid && ['host', 'origin', 'enterpriseId', 'site'].every(key => (left.auth[key] ?? '') === (right.auth[key] ?? ''));
  }
  // Other adapters have differing subject formats; only an exact OAuth token is conclusive.
  return typeof left.auth.access === 'string' && !!left.auth.access && left.auth.access === right.auth.access;
}

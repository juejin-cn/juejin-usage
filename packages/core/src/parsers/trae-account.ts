import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const TRAE_USAGE_COLLECTOR = 'trae-global-api';
export const TRAE_API_ORIGINS = {
  sg: 'https://api-sg-central.trae.ai',
  us: 'https://api-us-east.trae.ai',
} as const;
export interface TraeAccount { token: string; identity: string; origin: string; }
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function traeGlobalHomes(): string[] {
  const configured = process.env.TRAE_HOME?.trim();
  if (configured) return [configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : resolve(configured)];
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return ['Trae', 'TRAE', 'TRAE SOLO'].map(name => join(base, name));
}
export function hasTraeGlobalStorage(): boolean {
  return traeGlobalHomes().some(home => existsSync(join(home, 'User', 'globalStorage', 'storage.json')));
}

/** Trae byteCrypto envelope, independently decoded using its published client format.
 * This is the IDE login record, not the encrypted conversation database.
 * Protocol reference: https://github.com/junhoyeo/tokscale/blob/main/crates/tokscale-cli/src/trae.rs
 */
export function decodeTraeAuth(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { /* byteCrypto envelope below */ }
  if (value.length > 128_000 || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw new Error('TRAE_AUTH_UNREADABLE');
  const blob = Buffer.from(value, 'base64');
  if (blob.length < 118 || !blob.subarray(0, 6).equals(Buffer.from([116, 99, 5, 16, 0, 0])) || (blob.length - 38) % 16) throw new Error('TRAE_AUTH_UNREADABLE');
  const password = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const material = createHash('sha512').update(createHash('sha512').update(blob.subarray(6, 38)).digest()).update(password).digest();
  const cipher = createDecipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const plain = Buffer.concat([cipher.update(blob.subarray(38)), cipher.final()]);
  if (plain.length < 64 || !timingSafeEqual(plain.subarray(0, 64), createHash('sha512').update(plain.subarray(64)).digest())) throw new Error('TRAE_AUTH_UNREADABLE');
  return record(JSON.parse(plain.subarray(64).toString('utf8')));
}

export function parseTraeAccount(value: unknown): TraeAccount | null {
  const auth = decodeTraeAuth(value);
  if (typeof auth.token !== 'string' || auth.token.length < 20 || /\s/.test(auth.token)) return null;
  let claims: Record<string, unknown> = {};
  try { claims = record(JSON.parse(Buffer.from(auth.token.split('.')[1]!, 'base64url').toString())); } catch { /* opaque token */ }
  // Trae 3.6 resolves inference/billing residency separately from signup region.
  const rawRegion = record(auth.userRegion)._aiRegion ?? record(auth.account).uidRegion
    ?? auth.aiRegion ?? auth.region ?? claims.region;
  const region = typeof rawRegion === 'string' ? rawRegion.toLowerCase() : rawRegion;
  if (region !== undefined && region !== 'sg' && region !== 'us') throw new Error('TRAE_REGION_UNSUPPORTED');
  const subject = auth.userId ?? auth.user_id ?? claims.sub ?? claims.user_id;
  // Stable across token rotations when the local login provides an account id.
  const identity = createHash('sha256').update(`${region ?? 'sg'}:${(typeof subject === 'string' || typeof subject === 'number') && subject ? subject : auth.token}`).digest('hex');
  return { token: auth.token, identity, origin: TRAE_API_ORIGINS[region === 'us' ? 'us' : 'sg'] };
}

export async function readTraeAccount(): Promise<TraeAccount | null> {
  for (const home of traeGlobalHomes()) {
    let storage: Record<string, unknown>;
    try { storage = record(JSON.parse(await readFile(join(home, 'User', 'globalStorage', 'storage.json'), 'utf8'))); }
    catch { continue; }
    const raw = storage['iCubeAuthInfo://icube.cloudide'];
    if (raw == null) continue;
    const account = parseTraeAccount(raw);
    if (account) return account;
  }
  return null;
}

/** Never follow a redirect carrying an IDE credential or expose upstream bodies. */
export async function traeAccountRequest(account: TraeAccount, endpoint: string, body: unknown, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (!Object.values(TRAE_API_ORIGINS).includes(account.origin as typeof TRAE_API_ORIGINS.sg)) throw new Error('TRAE_REGION_UNSUPPORTED');
  const response = await fetcher(`${account.origin}/trae/api/v1/pay/${endpoint}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Cloud-IDE-JWT ${account.token}` }, body: JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) throw new Error('TRAE_AUTH_EXPIRED');
  if (!response.ok) throw new Error('TRAE_REQUEST_FAILED');
  const root = record(await response.json());
  const metadata = record(root.ResponseMetadata);
  const errorCode = record(metadata.Error).Code ?? root.code;
  if ([401, 403, '401', '403', 'InvalidToken', 'TokenExpired', 'Unauthorized'].includes(errorCode as string | number)) throw new Error('TRAE_AUTH_EXPIRED');
  if (metadata.Error || (root.code !== undefined && root.code !== 0 && root.code !== '0')) throw new Error('TRAE_REQUEST_FAILED');
  return record(root.Result ?? root.data ?? root);
}

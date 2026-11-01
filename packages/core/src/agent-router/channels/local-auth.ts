import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ChannelError, record, type Json } from './http.js';
export async function readLocalJson(path: string): Promise<Json> {
  try { if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error(); return record(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))); }
  catch { throw new ChannelError(401, 'SUBSCRIPTION_LOCAL_LOGIN_UNAVAILABLE'); }
}
export const accountHash = (identity: string) => createHash('sha256').update(identity).digest('hex');

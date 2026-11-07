import type { Readable } from 'node:stream';

/** Only the native parent's private pipe may supply this key. Never read it from env. */
export async function readHostBootstrap(input: Readable, enabled: boolean): Promise<{ hostKey?: string; vaultKey?: Buffer }> {
  if (!enabled) return {};
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const finish = (error?: Error, secrets: { hostKey?: string; vaultKey?: Buffer } = {}) => {
      clearTimeout(timer); input.off('data', data); input.off('end', ended);
      pending.fill(0); pending = Buffer.alloc(0);
      if (error) reject(error); else resolve(secrets);
    };
    const ended = () => finish(new Error('VAULT_BOOTSTRAP_CLOSED'));
    const data = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 1024) { finish(new Error('VAULT_BOOTSTRAP_INVALID')); return; }
      const end = pending.indexOf(10); if (end === -1) return;
      const line = pending.subarray(0, end).toString('utf8');
      let payload: { hostKey?: unknown; vaultKey?: unknown };
      try {
        if (!line.startsWith('BOOTSTRAP=')) throw new Error();
        payload = JSON.parse(line.slice('BOOTSTRAP='.length));
        if (typeof payload?.hostKey !== 'string' || !payload.hostKey || payload.hostKey.length > 200 || /[\s\x00]/.test(payload.hostKey)) throw new Error();
      } catch { finish(new Error('VAULT_BOOTSTRAP_INVALID')); return; }
      if (payload.vaultKey === null) { finish(undefined, { hostKey: payload.hostKey as string }); return; }
      if (typeof payload.vaultKey !== 'string') { finish(new Error('VAULT_BOOTSTRAP_INVALID')); return; }
      const key = Buffer.from(payload.vaultKey, 'base64');
      if (key.length !== 32 || key.toString('base64') !== payload.vaultKey) { key.fill(0); finish(new Error('VAULT_BOOTSTRAP_INVALID')); return; }
      finish(undefined, { hostKey: payload.hostKey as string, vaultKey: key });
    };
    const timer = setTimeout(() => finish(new Error('VAULT_BOOTSTRAP_TIMEOUT')), 10000);
    input.on('data', data); input.once('end', ended);
  });
}

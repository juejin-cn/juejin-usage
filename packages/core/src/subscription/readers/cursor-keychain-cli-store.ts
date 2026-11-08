import { execFile } from 'node:child_process';
import type { CursorKeychainPasswordStore } from './cursor-safe-storage.js';

const SECURITY_BIN = '/usr/bin/security';
const SERVICE = 'Juejin Usage Cursor Safe Storage';
const ACCOUNT = 'Cursor Key';

export type SecurityRunner = (args: string[], stdin?: string) => Promise<string>;

const runSecurity: SecurityRunner = (args, stdin) => new Promise((resolve, reject) => {
  const child = execFile(SECURITY_BIN, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 4096 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  child.stdin?.end(stdin ?? '');
});

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * macOS store for hosts without Electron safeStorage (Tauri sidecar). The item is
 * created by `/usr/bin/security`, so later reads through it stay silent — the same
 * trust level Cursor's own item gets after「始终允许」.
 */
export function createSecurityCliCursorKeychainPasswordStore(
  run: SecurityRunner = runSecurity,
): CursorKeychainPasswordStore {
  return {
    async load() {
      try {
        return (await run(['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])).trim() || null;
      } catch {
        return null;
      }
    },
    async save(password) {
      // Interactive mode reads the command from stdin so the password never appears in argv.
      await run(['-i'], `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(ACCOUNT)} -w ${quote(password)}\n`);
    },
    async clear() {
      await run(['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]).catch(() => {});
    },
  };
}

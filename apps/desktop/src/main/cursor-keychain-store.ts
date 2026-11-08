import { safeStorage } from 'electron';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cursorKeychainPasswordPath, resolveDataDir } from '@juejin-opensource/jusage-core';
import type { CursorKeychainPasswordStore } from '@juejin-opensource/jusage-core/subscription/readers/cursor-safe-storage';

/** Seals the Cursor Keychain password with this app's own safeStorage item, which reads without a dialog. */
export function createCursorKeychainPasswordStore(
  filePath = cursorKeychainPasswordPath(resolveDataDir()),
): CursorKeychainPasswordStore {
  return {
    async load() {
      if (!safeStorage.isEncryptionAvailable()) return null;
      let sealed: Buffer;
      try {
        sealed = await readFile(filePath);
      } catch {
        return null;
      }
      return safeStorage.decryptString(sealed) || null;
    },
    async save(password) {
      if (!safeStorage.isEncryptionAvailable()) return;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, safeStorage.encryptString(password), { mode: 0o600 });
    },
    async clear() {
      await unlink(filePath).catch(() => {});
    },
  };
}

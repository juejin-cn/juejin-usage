import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import type { CursorsFile } from '../types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Drop a file cursor only when the path is absolute, the file is gone, and
 * the parent directory still exists. That covers logrotate / deleted session
 * files while the tool install is present. If the parent is missing, the
 * volume may be unmounted or the whole tree temporarily unavailable; keep
 * lastTotals/offset so a later remount does not double-count.
 */
export function shouldPruneMissingCursorFile(filePath: string): boolean {
  if (!filePath || !isAbsolute(filePath)) return false;
  if (existsSync(filePath)) return false;
  const parent = dirname(filePath);
  if (!parent || parent === filePath) return false;
  return existsSync(parent);
}

/** Remove stale `files` entries from every channel cursor. Mutates in place. */
export function pruneMissingCursorFiles(cursors: CursorsFile): number {
  let removed = 0;
  for (const channel of Object.values(cursors)) {
    if (!isPlainObject(channel)) continue;
    const files = channel.files;
    if (!isPlainObject(files)) continue;
    for (const filePath of Object.keys(files)) {
      if (!shouldPruneMissingCursorFile(filePath)) continue;
      delete files[filePath];
      removed += 1;
    }
  }
  return removed;
}


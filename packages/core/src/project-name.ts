import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import { decodeEncodedProjectPath } from './project-label.js';

export {
  decodeEncodedProjectPath,
  normalizeProjectName,
} from './project-label.js';

const GIT_TIMEOUT_MS = 2_000;

/** Per-process: absolute dir → resolved project name (incl. basename fallback). */
const pathCache = new Map<string, string>();

/**
 * Once git is missing / unusable, skip further spawns for this process.
 * `null` = not probed yet; `true` = unavailable; `false` = available.
 */
let gitUnavailable: boolean | null = null;

/** Test-only: clear caches between cases. */
export function resetProjectNameCache(): void {
  pathCache.clear();
  gitUnavailable = null;
}

function normalizeDir(dir: string): string | null {
  const trimmed = dir.trim().replace(/[\\/]+$/, '');
  if (!trimmed || trimmed === 'unknown') return null;
  return trimmed;
}

function basenameFallback(dir: string): string {
  const name = basename(dir.replace(/\\/g, '/'));
  return name || 'unknown';
}

function gitToplevel(dir: string): string | null {
  if (gitUnavailable === true) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf-8',
        timeout: GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    gitUnavailable = false;
    const toplevel = out.trim();
    return toplevel || null;
  } catch (error: unknown) {
    const err = error as { code?: string; status?: number | null };
    // ENOENT / spawn failures → git not installed or not on PATH.
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      gitUnavailable = true;
    }
    return null;
  }
}

/**
 * Resolve a display project name from an absolute (or absolute-looking) path.
 *
 * 1. `git -C <dir> rev-parse --show-toplevel` → basename of repo root
 * 2. Else basename of `dir` (same as today's parsers)
 * 3. Empty / invalid → `unknown`
 *
 * Missing git, non-repo dirs, and timeouts all fall through to (2) silently.
 */
export function resolveProjectName(dir: string): string {
  const decoded = decodeEncodedProjectPath(dir);
  const normalized = normalizeDir(decoded);
  if (!normalized) return 'unknown';

  const cached = pathCache.get(normalized);
  if (cached) return cached;

  const toplevel = gitToplevel(normalized);
  const name = toplevel
    ? basenameFallback(toplevel)
    : basenameFallback(normalized);

  pathCache.set(normalized, name);
  return name;
}

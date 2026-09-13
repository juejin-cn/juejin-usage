import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_DATA_DIR } from './paths.js';

/** Who holds exclusive sync/upload ownership in `tud.pid`. */
export type RuntimeKind = 'cli' | 'desktop';

export interface RuntimeOwner {
  pid: number;
  kind: RuntimeKind;
  /**
   * Process start stamp from `ps` / Win32 CreationDate when the pid file was
   * written. Detects PID reuse after the original owner exited.
   */
  startedAt?: string;
}

export function pidFilePath(dataDir = DEFAULT_DATA_DIR): string {
  return join(dataDir, 'tud.pid');
}

export function runtimeKindLabel(kind: RuntimeKind): string {
  return kind === 'desktop' ? '桌面端' : 'CLI';
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but we cannot signal it.
    return Boolean(
      err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'EPERM',
    );
  }
}

function isRuntimeKind(value: unknown): value is RuntimeKind {
  return value === 'cli' || value === 'desktop';
}

function collapseWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function execPsField(pid: number, column: 'lstart=' | 'args='): string | null {
  try {
    const out = execFileSync('ps', ['-ww', '-p', String(pid), '-o', column], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // launchd/GUI jobs often have no LANG; keep the stamp comparable
      // between the daemon and `jusage service start`.
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const text = collapseWs(out);
    return text || null;
  } catch {
    return null;
  }
}

function execWinPowerShell(pid: number, field: 'CreationDate' | 'CommandLine'): string | null {
  // Round-trip ('o') so the stamp is culture-invariant: `isStillSameRuntimeProcess`
  // compares two reads for equality, and the default DateTime rendering follows
  // the machine locale.
  const select =
    field === 'CreationDate'
      ? "if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') }"
      : '$p.CommandLine';
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ${select}`,
      ],
      {
        encoding: 'utf-8',
        // A cold PowerShell start is slow on a loaded machine; a probe that
        // times out reads as "process not inspectable" and drops the owner.
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    return collapseWs(out) || null;
  } catch {
    return null;
  }
}

function execWinWmic(pid: number, field: 'CreationDate' | 'CommandLine'): string | null {
  try {
    const out = execFileSync(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', field, '/value'],
      {
        encoding: 'utf-8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const matched = new RegExp(`${field}=(.*)`).exec(out);
    const text = collapseWs(matched?.[1] ?? '');
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Both fields are fixed for the life of a pid, but reading them costs a process
 * spawn on Windows and one claim probes three times in a row (owner check, then
 * the write). Cache successes only, and briefly: `startedAt` exists to catch a
 * reused pid, so a long-lived entry would defeat the very check it feeds.
 */
const WIN_FIELD_CACHE_TTL_MS = 2_000;
const winFieldCache = new Map<string, { value: string; readAt: number }>();

/** Test seam. */
export function resetProcessFieldCache(): void {
  winFieldCache.clear();
}

/**
 * Read one Win32_Process field.
 *
 * PowerShell first: `wmic` is a deprecated Feature-on-Demand and is simply
 * absent on current Windows 11 / Server 2025 (verified on build 26100, where
 * `Get-Command wmic` finds nothing). When it goes missing this returned null
 * for every process, which made `isStillSameRuntimeProcess` reject every
 * recorded owner — so no CLI or Desktop instance was ever recognised as the
 * runtime owner and each one claimed the role for itself.
 *
 * `wmic` stays as a fallback for hosts where PowerShell is locked down.
 */
function execWinProcessField(pid: number, field: 'CreationDate' | 'CommandLine'): string | null {
  const key = `${pid}|${field}`;
  const cached = winFieldCache.get(key);
  if (cached && Date.now() - cached.readAt < WIN_FIELD_CACHE_TTL_MS) return cached.value;
  const value = execWinPowerShell(pid, field) ?? execWinWmic(pid, field);
  if (value) winFieldCache.set(key, { value, readAt: Date.now() });
  return value;
}

/** Stable start stamp for `pid`, or null when the process cannot be inspected. */
export function readProcessStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return execWinProcessField(pid, 'CreationDate');
  return execPsField(pid, 'lstart=');
}

/** Command line for `pid`, or null when the process cannot be inspected. */
export function readProcessArgs(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return execWinProcessField(pid, 'CommandLine');
  return execPsField(pid, 'args=');
}

export function argsMatchRuntimeKind(args: string, kind: RuntimeKind): boolean {
  const lower = args.toLowerCase();
  if (kind === 'desktop') {
    // Dev servers are siblings of Electron under electron-vite; never treat them
    // as a desktop runtime to evict.
    if (lower.includes('electron-vite') || lower.includes('vite.js')) return false;
    return (
      lower.includes('jusage-desktop') ||
      lower.includes('juejin usage') ||
      lower.includes('juejin-usage') ||
      lower.includes('com.juejin.tud.desktop') ||
      (lower.includes('electron') && (lower.includes('jusage') || lower.includes('juejin')))
    );
  }
  if (
    lower.includes('jusage-desktop') ||
    lower.includes('jusage-core') ||
    lower.includes('jusage-dashboard') ||
    lower.includes('electron-vite')
  ) {
    return false;
  }
  return (
    lower.includes('jusage.js') ||
    lower.includes('@juejin-opensource/jusage/') ||
    /(?:^|[\s/\\])jusage(?:\.cmd)?(?:\s|$)/.test(lower)
  );
}

/**
 * True when `owner.pid` is still the process that wrote the pid file.
 * Legacy records without `startedAt` must look like CLI/desktop; a reused PID
 * of an unrelated process is treated as stale.
 */
export function isStillSameRuntimeProcess(owner: RuntimeOwner): boolean {
  if (!isPidAlive(owner.pid)) return false;

  const args = readProcessArgs(owner.pid);
  const looksLikeRuntime = Boolean(args && argsMatchRuntimeKind(args, owner.kind));

  if (owner.startedAt) {
    const start = readProcessStart(owner.pid);
    if (start && start === owner.startedAt) return true;
    // Locale/format noise can make `ps -o lstart=` differ across processes.
    // Only treat a mismatch as PID reuse when the command line is missing or
    // does not look like CLI/desktop.
    if (start && start !== owner.startedAt) return looksLikeRuntime;
    // Could not re-read start time; keep the owner only if the command still
    // looks like the claimed runtime.
  }

  if (!args) {
    // Legacy / unreadable: do not treat a live unrelated PID as our desktop.
    return Boolean(owner.startedAt);
  }
  return looksLikeRuntime;
}

/** Parse pid file: JSON `{pid,kind,startedAt?}` or legacy plain integer (treated as CLI). */
export function parseRuntimeOwner(raw: string): RuntimeOwner | null {
  const text = raw.trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as {
        pid?: unknown;
        kind?: unknown;
        startedAt?: unknown;
      };
      const pid = Number(parsed.pid);
      if (!Number.isInteger(pid) || pid <= 0 || !isRuntimeKind(parsed.kind)) {
        return null;
      }
      const startedAt =
        typeof parsed.startedAt === 'string' && parsed.startedAt.trim()
          ? parsed.startedAt.trim()
          : undefined;
      return startedAt ? { pid, kind: parsed.kind, startedAt } : { pid, kind: parsed.kind };
    } catch {
      return null;
    }
  }

  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Legacy plain-pid files were written by CLI before kind existed.
  return { pid, kind: 'cli' };
}

export async function readRuntimeOwner(
  dataDir = DEFAULT_DATA_DIR,
): Promise<RuntimeOwner | null> {
  const path = pidFilePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    return parseRuntimeOwner(raw);
  } catch {
    return null;
  }
}

/** Pid-only helper; use `readRuntimeOwner` when `kind` is needed. */
export async function readPid(
  dataDir = DEFAULT_DATA_DIR,
): Promise<number | null> {
  return (await readRuntimeOwner(dataDir))?.pid ?? null;
}

export async function writeRuntimeOwner(
  owner: RuntimeOwner,
  dataDir = DEFAULT_DATA_DIR,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const startedAt = owner.startedAt ?? readProcessStart(owner.pid) ?? undefined;
  const payload = JSON.stringify({
    pid: owner.pid,
    kind: owner.kind,
    ...(startedAt ? { startedAt } : {}),
  });
  await writeFile(pidFilePath(dataDir), `${payload}\n`, 'utf8');
}

/** Write owner record; defaults `kind` to `cli` for callers that only pass a pid. */
export async function writePid(
  pid: number,
  dataDir = DEFAULT_DATA_DIR,
  kind: RuntimeKind = 'cli',
): Promise<void> {
  await writeRuntimeOwner({ pid, kind }, dataDir);
}

export async function clearPid(dataDir = DEFAULT_DATA_DIR): Promise<void> {
  const path = pidFilePath(dataDir);
  if (!existsSync(path)) return;
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

export async function getRunningOwner(
  dataDir = DEFAULT_DATA_DIR,
): Promise<RuntimeOwner | null> {
  const owner = await readRuntimeOwner(dataDir);
  if (owner == null) return null;
  if (!isStillSameRuntimeProcess(owner)) {
    await clearPid(dataDir);
    return null;
  }
  return owner;
}

/** Pid-only helper; use `getRunningOwner` when `kind` is needed. */
export async function getRunningPid(
  dataDir = DEFAULT_DATA_DIR,
): Promise<number | null> {
  return (await getRunningOwner(dataDir))?.pid ?? null;
}

export type RuntimeClaimResult =
  | { role: 'owner'; pid: number; kind: RuntimeKind }
  | { role: 'observer'; ownerPid: number; ownerKind: RuntimeKind };

/**
 * Soft then hard kill. Returns true if the process is gone.
 * Never signals the current process.
 */
export async function stopPid(pid: number, timeoutMs = 5000): Promise<boolean> {
  if (pid === process.pid) return false;
  if (!isPidAlive(pid)) return true;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isPidAlive(pid);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!isPidAlive(pid)) return true;

  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // ignore
  }

  await new Promise((r) => setTimeout(r, 200));
  return !isPidAlive(pid);
}

/**
 * Claim exclusive sync/upload ownership via `tud.pid`.
 * If another live process already owns the file, return observer (+ owner kind)
 * unless `force` is set — then stop that process and take the lock.
 */
export async function claimRuntimeOwner(
  dataDir: string,
  opts: { pid?: number; kind: RuntimeKind; force?: boolean } = { kind: 'cli' },
): Promise<RuntimeClaimResult> {
  const pid = opts.pid ?? process.pid;
  const kind = opts.kind;
  const existing = await getRunningOwner(dataDir);
  if (existing != null && existing.pid !== pid) {
    if (!opts.force) {
      return {
        role: 'observer',
        ownerPid: existing.pid,
        ownerKind: existing.kind,
      };
    }
    const stopped = await stopPid(existing.pid);
    if (!stopped && isPidAlive(existing.pid)) {
      throw new Error(
        `无法结束占用进程 ${runtimeKindLabel(existing.kind)} pid ${existing.pid}`,
      );
    }
    await clearPid(dataDir);
  }
  await writeRuntimeOwner({ pid, kind }, dataDir);
  return { role: 'owner', pid, kind };
}

/** Clear `tud.pid` only when it still points at this process. */
export async function releaseRuntimeOwner(
  dataDir: string,
  pid = process.pid,
): Promise<void> {
  const current = await readRuntimeOwner(dataDir);
  if (current?.pid === pid) {
    await clearPid(dataDir);
  }
}

export async function isRuntimeOwner(
  dataDir: string,
  pid = process.pid,
): Promise<boolean> {
  const running = await getRunningOwner(dataDir);
  return running?.pid === pid;
}

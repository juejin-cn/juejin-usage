import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_DATA_DIR,
  argsMatchRuntimeKind,
  logsDir,
  clearPid,
  getRunningOwner,
  getRunningPid,
  isPidAlive,
  pidFilePath,
  readPid,
  readProcessArgs,
  readRuntimeOwner,
  stopPid,
  writePid,
  writeRuntimeOwner,
} from '@juejin-opensource/jusage-core';

import { DEFAULT_HOST, formatListenUrl } from './args.js';

export {
  clearPid,
  getRunningOwner,
  getRunningPid,
  isPidAlive,
  pidFilePath,
  readPid,
  readRuntimeOwner,
  stopPid,
  writePid,
  writeRuntimeOwner,
};

export function daemonLogPath(dataDir = DEFAULT_DATA_DIR): string {
  return join(logsDir(dataDir), 'daemon.log');
}

export async function ensureDaemonLogDir(dataDir = DEFAULT_DATA_DIR): Promise<string> {
  const dir = logsDir(dataDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function readLivePid(dataDir: string): Promise<number | null> {
  // Do not go through getRunningOwner: a locale-mismatched startedAt would
  // delete the pid file the daemon just wrote, and this wait would never see it.
  const owner = await readRuntimeOwner(dataDir);
  if (owner != null && isPidAlive(owner.pid)) return owner.pid;
  return null;
}

/** True when local-api `/health` returns `{ ok: true }`. */
export async function probeLocalHealth(
  port: number,
  host = DEFAULT_HOST,
): Promise<boolean> {
  try {
    const res = await fetch(`${formatListenUrl(host, port)}/health`, {
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function readListeningPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 3_000 },
      );
      const pid = Number((result.stdout ?? '').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    const result = spawnSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 2_000 },
    );
    const pid = Number((result.stdout ?? '').trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function recoverPidFromHealth(dataDir: string, port: number): Promise<number | null> {
  const listenPid = readListeningPid(port);
  if (listenPid == null || !isPidAlive(listenPid)) return null;
  const args = readProcessArgs(listenPid) ?? '';
  const kind = argsMatchRuntimeKind(args, 'desktop')
    ? 'desktop'
    : argsMatchRuntimeKind(args, 'cli')
      ? 'cli'
      : null;
  if (!kind) return null;
  await writePid(listenPid, dataDir, kind);
  return listenPid;
}

export async function waitForPid(
  dataDir = DEFAULT_DATA_DIR,
  timeoutMs = 15_000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readLivePid(dataDir);
    if (pid != null) return pid;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getRunningPid(dataDir);
}

export interface ServiceReady {
  pid: number | null;
  health: boolean;
}

/** Wait until the pid file is live, or `/health` is up as a fallback. */
export async function waitForServiceReady(
  dataDir: string,
  port: number,
  host = DEFAULT_HOST,
  timeoutMs = 15_000,
): Promise<ServiceReady> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readLivePid(dataDir);
    if (pid != null) return { pid, health: await probeLocalHealth(port, host) };
    if (await probeLocalHealth(port, host)) {
      return { pid: await recoverPidFromHealth(dataDir, port), health: true };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const pid = (await readLivePid(dataDir)) ?? (await getRunningPid(dataDir));
  if (pid != null) return { pid, health: await probeLocalHealth(port, host) };
  if (await probeLocalHealth(port, host)) {
    return { pid: await recoverPidFromHealth(dataDir, port), health: true };
  }
  return { pid: null, health: false };
}

export async function readDaemonLogTail(
  dataDir = DEFAULT_DATA_DIR,
  maxChars = 2000,
): Promise<string> {
  try {
    const raw = await readFile(daemonLogPath(dataDir), 'utf8');
    const trimmed = raw.trimEnd();
    if (!trimmed) return '';
    return trimmed.length <= maxChars ? trimmed : trimmed.slice(-maxChars);
  } catch {
    return '';
  }
}

function resolveExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolveServiceCommand(cliBinPath: string): {
  nodePath: string;
  args: string[];
  commandLine: string;
} {
  // fnm/nvm shims live in session-specific dirs; persist the real binary.
  const nodePath = resolveExistingPath(process.execPath);
  const binPath = resolveExistingPath(cliBinPath);
  const args = [binPath, 'start'];
  const commandLine =
    process.platform === 'win32'
      ? `"${nodePath}" "${binPath}" start`
      : `${shellQuote(nodePath)} ${shellQuote(binPath)} start`;
  return { nodePath, args, commandLine };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

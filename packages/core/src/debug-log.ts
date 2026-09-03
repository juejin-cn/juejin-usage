import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { LOG_MAX_BYTES } from './paths.js';

export async function rotateLogIfNeeded(logPath: string): Promise<void> {
  if (!existsSync(logPath)) return;
  const st = await stat(logPath);
  if (st.size < LOG_MAX_BYTES) return;
  const backupPath = `${logPath}.1`;
  if (existsSync(backupPath)) {
    await unlink(backupPath);
  }
  await rename(logPath, backupPath);
}

export async function appendJsonLog(
  logPath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await rotateLogIfNeeded(logPath);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    await appendFile(logPath, line, 'utf8');
  } catch {
    // debug logging must never throw
  }
}

function cpuRole(): 'sync-worker' | 'main' {
  return process.title === 'tud-sync-worker' ? 'sync-worker' : 'main';
}

/**
 * Time a sync phase with wall clock + process.cpuUsage so we can see which
 * step burned CPU, not just which step waited on I/O.
 * Quiet when both wall and CPU are under 2ms (skip/cache hits).
 */
export async function measureCpuPhase<T>(
  logPath: string,
  phase: string,
  extra: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const cpu = process.cpuUsage(cpu0);
    const wallMs = Date.now() - t0;
    const cpuUserMs = Math.round(cpu.user / 1000);
    const cpuSystemMs = Math.round(cpu.system / 1000);
    const cpuMs = cpuUserMs + cpuSystemMs;
    if (wallMs >= 2 || cpuMs >= 2) {
      await appendJsonLog(logPath, {
        event: 'cpu_phase',
        phase,
        pid: process.pid,
        role: cpuRole(),
        wallMs,
        cpuMs,
        cpuUserMs,
        cpuSystemMs,
        ...extra,
      });
    }
  }
}

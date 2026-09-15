/**
 * Stop CLI launchd / scheduled-task / systemd-user autostart so KeepAlive
 * cannot revive jusage after the desktop client takes over.
 *
 * Labels must stay aligned with packages/cli service-macos.ts / service-windows.ts /
 * service-linux.ts.
 */
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { LINUX_UNIT_NAME } from './service-linux.js';

const MACOS_LABELS = ['com.juejin.jusage', 'com.ai-usage.tud'] as const;
const WINDOWS_TASK_NAMES = ['jusage', 'ai-usage-tud'] as const;

function macosPlistPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function linuxUnitPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdgConfigHome || join(homedir(), '.config');
  return join(base, 'systemd', 'user', `${LINUX_UNIT_NAME}.service`);
}

function runLaunchctl(args: string[]): void {
  spawnSync('launchctl', args, { encoding: 'utf8', stdio: 'ignore' });
}

function runSystemctl(args: string[]): void {
  spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: 'ignore' });
}

async function evictMacosCliAutostart(): Promise<void> {
  const uid = String(process.getuid?.() ?? 501);
  const domain = `gui/${uid}`;
  for (const label of MACOS_LABELS) {
    const plistPath = macosPlistPath(label);
    runLaunchctl(['bootout', `${domain}/${label}`]);
    runLaunchctl(['unload', plistPath]);
    if (existsSync(plistPath)) {
      try {
        await unlink(plistPath);
      } catch {
        // ignore
      }
    }
  }
}

function evictWindowsCliAutostart(): void {
  const quoted = WINDOWS_TASK_NAMES.map((name) => `'${name.replace(/'/g, "''")}'`).join(
    ', ',
  );
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$ErrorActionPreference = 'SilentlyContinue'; foreach ($taskName in @(${quoted})) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }`,
    ],
    { encoding: 'utf8', windowsHide: true, stdio: 'ignore' },
  );
}

async function evictLinuxCliAutostart(): Promise<void> {
  // Mirror unregisterLinuxAutostart() in service-linux.ts (disable + stop +
  // remove unit file + daemon-reload), best-effort: a missing systemd user
  // instance is a no-op, same as the macOS/Windows branches.
  runSystemctl(['disable', '--now', `${LINUX_UNIT_NAME}.service`]);
  runSystemctl(['stop', `${LINUX_UNIT_NAME}.service`]);
  const unitPath = linuxUnitPath();
  if (existsSync(unitPath)) {
    try {
      await unlink(unitPath);
    } catch {
      // ignore
    }
  }
  runSystemctl(['daemon-reload']);
}

/** Best-effort: never throw. Missing CLI autostart is a no-op. */
export async function evictCliAutostart(): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await evictMacosCliAutostart();
      return;
    }
    if (process.platform === 'win32') {
      evictWindowsCliAutostart();
      return;
    }
    if (process.platform === 'linux') {
      await evictLinuxCliAutostart();
    }
  } catch (err) {
    console.warn(
      '[tud-desktop] failed to evict CLI autostart:',
      err instanceof Error ? err.message : err,
    );
  }
}

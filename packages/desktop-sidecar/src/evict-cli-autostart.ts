/**
 * Stop CLI launchd / scheduled-task autostart so KeepAlive cannot revive
 * jusage after the desktop client takes over.
 *
 * Labels must stay aligned with packages/cli service-macos.ts / service-windows.ts.
 */
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const MACOS_LABELS = ['com.juejin.jusage', 'com.ai-usage.tud'] as const;
const WINDOWS_TASK_NAMES = ['jusage', 'ai-usage-tud'] as const;

function macosPlistPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function runLaunchctl(args: string[]): void {
  spawnSync('launchctl', args, { encoding: 'utf8', stdio: 'ignore' });
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

/** Best-effort: never throw. Missing CLI autostart is a no-op. */
export async function evictCliAutostart(): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await evictMacosCliAutostart();
      return;
    }
    if (process.platform === 'win32') {
      evictWindowsCliAutostart();
    }
  } catch (err) {
    console.warn(
      '[tud-desktop] failed to evict CLI autostart:',
      err instanceof Error ? err.message : err,
    );
  }
}

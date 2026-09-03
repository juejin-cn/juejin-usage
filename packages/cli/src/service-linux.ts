import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { daemonLogPath, ensureDaemonLogDir, resolveServiceCommand } from './daemon.js';

export const LINUX_UNIT_NAME = 'jusage';

const SYSTEMD_HINT =
  '可用 jusage start 前台运行。若在 WSL，请在 /etc/wsl.conf 启用 [boot] systemd=true 后执行 wsl --shutdown 再打开。';

function systemdConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg || join(homedir(), '.config');
}

export function linuxUnitPath(): string {
  return join(systemdConfigHome(), 'systemd', 'user', `${LINUX_UNIT_NAME}.service`);
}

function defaultPath(nodePath: string, home: string): string {
  const parts = [
    dirname(nodePath),
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(parts)].join(':');
}

/** Quote a systemd unit value; `%` is a specifier and must be doubled. */
export function systemdQuote(value: string): string {
  const escapedPct = value.replace(/%/g, '%%');
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return escapedPct;
  return `"${escapedPct.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function envLine(key: string, value: string): string {
  const assignment = `${key}=${value.replace(/%/g, '%%')}`;
  if (/^[A-Za-z0-9_]+=[A-Za-z0-9_./:@+=,-]+$/.test(`${key}=${value}`)) {
    return `Environment=${key}=${value}`;
  }
  return `Environment="${assignment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildLinuxUnit(
  nodePath: string,
  args: readonly string[],
  home: string,
  logPath: string,
): string {
  const execStart = [nodePath, ...args].map(systemdQuote).join(' ');
  const quotedHome = systemdQuote(home);
  const output = `append:${systemdQuote(logPath)}`;
  return `[Unit]
Description=Juejin Usage CLI
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${quotedHome}
Restart=always
RestartSec=3
${envLine('HOME', home)}
${envLine('LANG', 'en_US.UTF-8')}
${envLine('LC_ALL', 'en_US.UTF-8')}
${envLine('PATH', defaultPath(nodePath, home))}
StandardOutput=${output}
StandardError=${output}

[Install]
WantedBy=default.target
`;
}

function isCommandMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function runSystemctl(args: string[]): { ok: boolean; stderr: string; missing: boolean } {
  const result = spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout: 8_000,
  });
  const missing = isCommandMissing(result.error);
  const stderr = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  return { ok: result.status === 0 && !missing, stderr, missing };
}

function assertSystemdUser(): void {
  const probe = runSystemctl(['show-environment']);
  if (probe.missing) {
    throw new Error(
      `jusage service 在 Linux 上需要 systemd 用户服务，未找到 systemctl。${SYSTEMD_HINT}`,
    );
  }
  if (!probe.ok) {
    throw new Error(
      `jusage service 在 Linux 上需要可用的 systemd 用户实例（systemctl --user）。${probe.stderr ? ` ${probe.stderr}` : ''} ${SYSTEMD_HINT}`,
    );
  }
}

export async function isLinuxAutostartRegistered(): Promise<boolean> {
  const unitPath = linuxUnitPath();
  if (!existsSync(unitPath)) return false;
  return runSystemctl(['is-enabled', '--quiet', `${LINUX_UNIT_NAME}.service`]).ok;
}

export async function registerLinuxAutostart(cliBinPath: string, dataDir: string): Promise<void> {
  assertSystemdUser();
  await ensureDaemonLogDir(dataDir);

  // Stop the previous unit before rewrite so Restart=always does not fight us.
  await unregisterLinuxAutostart();

  const unitPath = linuxUnitPath();
  await mkdir(dirname(unitPath), { recursive: true });
  const { nodePath, args } = resolveServiceCommand(cliBinPath);
  await writeFile(unitPath, buildLinuxUnit(nodePath, args, homedir(), daemonLogPath(dataDir)), 'utf8');

  const reloaded = runSystemctl(['daemon-reload']);
  if (!reloaded.ok) {
    await unregisterLinuxAutostart();
    throw new Error(`注册 Linux 自启失败（daemon-reload）: ${reloaded.stderr || 'systemctl 返回非零'}`);
  }

  const enabled = runSystemctl(['enable', '--now', `${LINUX_UNIT_NAME}.service`]);
  if (!enabled.ok) {
    await unregisterLinuxAutostart();
    throw new Error(`注册 Linux 自启失败: ${enabled.stderr || 'systemctl enable --now 返回非零'}`);
  }
}

export async function unregisterLinuxAutostart(): Promise<void> {
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

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

import { ensureDaemonLogDir, resolveServiceCommand } from './daemon.js';

export const WINDOWS_TASK_NAME = 'jusage';
/** Previous scheduled-task name; remove on start/stop so upgrades do not leave two daemons. */
export const LEGACY_WINDOWS_TASK_NAME = 'ai-usage-tud';

function runPowerShell(script: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function isWindowsAutostartRegistered(): Promise<boolean> {
  const result = runPowerShell(
    `Get-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName`,
  );
  return result.ok && result.stdout.includes(WINDOWS_TASK_NAME);
}

export async function registerWindowsAutostart(cliBinPath: string, dataDir: string): Promise<void> {
  await ensureDaemonLogDir(dataDir);
  await unregisterWindowsAutostart();
  const { nodePath, args } = resolveServiceCommand(cliBinPath);
  const argument = args.map((a) => `"${a}"`).join(' ');

  const script = `
$ErrorActionPreference = 'Stop'
$taskName = ${psQuote(WINDOWS_TASK_NAME)}
$action = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${psQuote(argument)} -WorkingDirectory ${psQuote(homedir())}
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
`;

  const result = runPowerShell(script);
  if (!result.ok) {
    const raw = result.stderr || result.stdout || 'PowerShell 返回非零';
    if (/0x80070005|拒绝访问|Access is denied|PermissionDenied/i.test(raw)) {
      throw new Error(
        '注册 Windows 开机自启需要管理员权限:请右键「以管理员身份运行」终端后重新执行 `jusage service start`(服务已在运行时会自动补注册自启);或改用 `jusage start` 前台运行(无开机自启)',
      );
    }
    throw new Error(`注册 Windows 开机自启失败: ${raw}`);
  }
}

export async function unregisterWindowsAutostart(): Promise<void> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($taskName in @(${psQuote(WINDOWS_TASK_NAME)}, ${psQuote(LEGACY_WINDOWS_TASK_NAME)})) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
`;
  runPowerShell(script);
}

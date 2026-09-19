import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  claudeSettingsPath,
  codexNotifyOriginalPath,
  notifyLogPath,
  notifyPs1Path,
  notifyScriptPath,
  notifyScriptPathLegacy,
  NOTIFY_THROTTLE_MS,
  LOG_MAX_BYTES,
} from '../paths.js';

/** Fires each turn when Claude finishes responding (not only on session exit). */
export const CLAUDE_HOOK_EVENTS = ['Stop', 'SessionEnd'] as const;

function quoteArg(s: string): string {
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function quoteWinArg(s: string): string {
  if (!/[ \t"]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** True if a Claude/Codex hook command string is one of ours (any notify generation). */
export function isNotifyHookCommand(command: string | undefined, source = 'claude'): boolean {
  if (typeof command !== 'string') return false;
  if (!command.includes(`--source=${source}`)) return false;
  return /notify\.(mjs|sh|cmd|ps1)/.test(command);
}

/**
 * Hook command registered in Claude settings / Codex hooks.json.
 * Uses bash (macOS/Linux) or cmd script (Windows) — no system Node required.
 */
export function buildHookCommand(notifyPath: string, source = 'claude'): string {
  if (process.platform === 'win32') {
    // Claude Code runs hooks via Git Bash on Windows, which strips backslashes.
    return `${quoteWinArg(notifyPath.replace(/\\/g, '/'))} --source=${source}`;
  }
  return `/bin/bash ${quoteArg(notifyPath)} --source=${source}`;
}

/**
 * Bash notify: write notify.signal (+ per-source throttle) and optionally chain
 * the original Codex notify. Sync/upload is owned by the desktop/CLI runtime.
 */
export function buildNotifySh(dataDir: string): string {
  const throttleSec = Math.max(1, Math.ceil(NOTIFY_THROTTLE_MS / 1000));
  const codexOriginalPath = codexNotifyOriginalPath(dataDir);
  const logPath = notifyLogPath(dataDir);
  const logMaxBytes = LOG_MAX_BYTES;

  return `#!/bin/bash
set +e
source="claude"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source=*) source="\${1#--source=}" ;;
    --source)
      shift
      source="\${1:-claude}"
      ;;
  esac
  shift
done

DATA_DIR=${shSingleQuote(dataDir)}
CODEX_ORIGINAL=${shSingleQuote(codexOriginalPath)}
NOTIFY_LOG=${shSingleQuote(logPath)}
LOG_MAX_BYTES=${logMaxBytes}
THROTTLE_SEC=${throttleSec}
THROTTLE_PATH="$DATA_DIR/notify.throttle.$source"
SIGNAL_PATH="$DATA_DIR/notify.signal"

append_log() {
  local event="$1"
  local extra="\${2:-}"
  mkdir -p "$(dirname "$NOTIFY_LOG")" 2>/dev/null || true
  if [ -f "$NOTIFY_LOG" ]; then
    local size
    size=$(wc -c < "$NOTIFY_LOG" 2>/dev/null | tr -d ' ' || echo 0)
    if [ "\${size:-0}" -ge "$LOG_MAX_BYTES" ] 2>/dev/null; then
      rm -f "$NOTIFY_LOG.1" 2>/dev/null || true
      mv "$NOTIFY_LOG" "$NOTIFY_LOG.1" 2>/dev/null || true
    fi
  fi
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
  if [ -n "$extra" ]; then
    printf '{"ts":"%s","event":"%s","source":"%s",%s}\\n' "$ts" "$event" "$source" "$extra" >> "$NOTIFY_LOG" 2>/dev/null || true
  else
    printf '{"ts":"%s","event":"%s","source":"%s"}\\n' "$ts" "$event" "$source" >> "$NOTIFY_LOG" 2>/dev/null || true
  fi
}

append_log "hook"

now=$(date +%s 2>/dev/null || echo 0)
last=0
if [ -f "$THROTTLE_PATH" ]; then
  # First line only — corrupt multi-line files must not concatenate digits.
  last=$(head -n 1 "$THROTTLE_PATH" 2>/dev/null || echo 0)
fi
# strip non-digits
last=$(printf '%s' "$last" | tr -cd '0-9')
last=\${last:-0}
# Legacy notify.mjs wrote milliseconds; treat >1e11 or future values as stale.
if [ "$last" -gt 100000000000 ] 2>/dev/null; then
  last=$((last / 1000))
fi
if [ "$last" -gt "$now" ] 2>/dev/null; then
  last=0
fi
if [ "$((now - last))" -lt "$THROTTLE_SEC" ] 2>/dev/null; then
  append_log "throttled" "\\"waitSec\\":$((THROTTLE_SEC - (now - last)))"
else
  printf '%s' "$now" > "$THROTTLE_PATH" 2>/dev/null || true
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
  printf '{"ts":"%s","source":"%s"}\\n' "$ts" "$source" > "$SIGNAL_PATH" 2>/dev/null && append_log "signal" || append_log "signal_error"
fi

if [ "$source" = "codex" ] && [ -f "$CODEX_ORIGINAL" ]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CODEX_ORIGINAL" <<'PY' >/dev/null 2>&1 &
import json, os, subprocess, sys
path = sys.argv[1]
try:
    data = json.load(open(path, encoding="utf-8"))
    cmd = data.get("notify")
    if not isinstance(cmd, list) or not cmd:
        raise SystemExit(0)
    joined = " ".join(str(x) for x in cmd)
    if "notify.mjs" in joined or "notify.sh" in joined or "notify.cmd" in joined:
        raise SystemExit(0)
    exe = str(cmd[0])
    if exe.startswith("~/"):
        exe = os.path.join(os.path.expanduser("~"), exe[2:])
    args = [exe] + [str(x) for x in cmd[1:]]
    subprocess.Popen(args, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except Exception:
    pass
PY
  fi
fi

exit 0
`;
}

/**
 * Windows PowerShell notify body (invoked by notify.cmd).
 */
export function buildNotifyPs1(dataDir: string): string {
  const throttleSec = Math.max(1, Math.ceil(NOTIFY_THROTTLE_MS / 1000));
  const codexOriginalPath = codexNotifyOriginalPath(dataDir);
  const logPath = notifyLogPath(dataDir);
  const logMaxBytes = LOG_MAX_BYTES;

  return `$ErrorActionPreference = 'SilentlyContinue'
$source = 'claude'
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($a -eq '--source' -and ($i + 1) -lt $args.Count) {
    $source = [string]$args[$i + 1]
    $i++
    continue
  }
  if ($a.StartsWith('--source=')) {
    $source = $a.Substring('--source='.Length)
  }
}

$dataDir = ${JSON.stringify(dataDir)}
$codexOriginalPath = ${JSON.stringify(codexOriginalPath)}
$notifyLogPath = ${JSON.stringify(logPath)}
$logMaxBytes = ${logMaxBytes}
$throttleSec = ${throttleSec}
$throttlePath = Join-Path $dataDir ("notify.throttle." + $source)
$signalPath = Join-Path $dataDir 'notify.signal'

function Append-Log([string]$event) {
  try {
    $dir = Split-Path -Parent $notifyLogPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (Test-Path $notifyLogPath) {
      if ((Get-Item $notifyLogPath).Length -ge $logMaxBytes) {
        $backup = $notifyLogPath + '.1'
        if (Test-Path $backup) { Remove-Item $backup -Force }
        Rename-Item $notifyLogPath $backup -Force
      }
    }
    $line = (@{ ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); event = $event; source = $source } | ConvertTo-Json -Compress)
    Add-Content -Path $notifyLogPath -Value $line -Encoding utf8
  } catch {}
}

Append-Log 'hook'

try {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $last = 0
  if (Test-Path $throttlePath) {
    try {
      $raw = ((Get-Content $throttlePath -TotalCount 1 -ErrorAction Stop) | Out-String).Trim()
      $digits = ($raw -replace '[^0-9]', '')
      if ($digits) { $last = [long]$digits }
    } catch { $last = 0 }
  }
  # Legacy notify.mjs wrote milliseconds.
  if ($last -gt 100000000000) { $last = [long]([math]::Floor($last / 1000)) }
  if ($last -gt $now) { $last = 0 }
  if (($now - $last) -lt $throttleSec) {
    Append-Log 'throttled'
  } else {
    Set-Content -Path $throttlePath -Value ([string]$now) -Encoding ascii -NoNewline
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    $payload = (@{ ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); source = $source } | ConvertTo-Json -Compress)
    Set-Content -Path $signalPath -Value $payload -Encoding utf8
    Append-Log 'signal'
  }
} catch {
  Append-Log 'signal_error'
}

if ($source -eq 'codex' -and (Test-Path $codexOriginalPath)) {
  try {
    $j = Get-Content $codexOriginalPath -Raw | ConvertFrom-Json
    $cmd = @($j.notify)
    if ($cmd.Count -gt 0) {
      $joined = ($cmd -join ' ')
      if ($joined -notmatch 'notify\\.(mjs|sh|cmd|ps1)') {
        $exe = [string]$cmd[0]
        if ($exe.StartsWith('~/')) { $exe = Join-Path $HOME $exe.Substring(2) }
        $argList = @()
        if ($cmd.Count -gt 1) { $argList = $cmd[1..($cmd.Count - 1)] }
        Start-Process -FilePath $exe -ArgumentList $argList -WindowStyle Hidden | Out-Null
      }
    }
  } catch {}
}

exit 0
`;
}

/**
 * Thin cmd wrapper so Claude/Codex can invoke without knowing PowerShell flags.
 */
export function buildNotifyCmd(_dataDir: string): string {
  return `@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify.ps1" %*
exit /b %ERRORLEVEL%
`;
}

/** Platform notify script body (sh on Unix, cmd wrapper on Windows). */
export function buildNotifyScript(dataDir: string): string {
  return process.platform === 'win32' ? buildNotifyCmd(dataDir) : buildNotifySh(dataDir);
}

export async function writeNotifyScript(dataDir: string): Promise<string> {
  const path = notifyScriptPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(notifyPs1Path(dataDir), buildNotifyPs1(dataDir), 'utf8');
    await writeFile(path, buildNotifyCmd(dataDir), 'utf8');
  } else {
    await writeFile(path, buildNotifySh(dataDir), 'utf8');
    await chmod(path, 0o755);
  }
  // Drop legacy ms throttle stamps so bash/ps1 second-based throttle can fire.
  try {
    for (const name of await readdir(dataDir)) {
      if (!name.startsWith('notify.throttle.')) continue;
      try {
        await unlink(join(dataDir, name));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  const legacy = notifyScriptPathLegacy(dataDir);
  if (legacy !== path && existsSync(legacy)) {
    try {
      await unlink(legacy);
    } catch {
      // ignore
    }
  }
  return path;
}

interface HookEntry {
  hooks?: Array<{ type?: string; command?: string }>;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasHook(entries: HookEntry[], command: string): boolean {
  for (const entry of entries) {
    for (const h of entry.hooks ?? []) {
      if (h.type === 'command' && h.command === command) return true;
    }
  }
  return false;
}

function pruneStaleNotifyHooks(entries: HookEntry[], keepCommand: string, source = 'claude'): HookEntry[] {
  const pruned = entries
    .map((entry) => ({
      hooks: (entry.hooks ?? []).filter(
        (h) => !(h.type === 'command' && isNotifyHookCommand(h.command, source) && h.command !== keepCommand),
      ),
    }))
    .filter((entry) => (entry.hooks ?? []).length > 0);
  return pruned.length === entries.length &&
    entries.every((entry, i) => (entry.hooks ?? []).length === (pruned[i]?.hooks ?? []).length)
    ? entries
    : pruned;
}

export async function upsertClaudeHook(
  notifyPath: string,
  events: readonly string[] = CLAUDE_HOOK_EVENTS,
): Promise<{ changed: boolean; configured: boolean }> {
  const settingsPath = claudeSettingsPath();
  const hookCommand = buildHookCommand(notifyPath, 'claude');
  const existing = await readJson(settingsPath);
  const settings = existing ?? {};
  const hooks = (settings.hooks as Record<string, HookEntry[]>) ?? {};
  let changed = false;

  for (const event of events) {
    let entries = Array.isArray(hooks[event]) ? [...hooks[event]!] : [];
    const cleaned = pruneStaleNotifyHooks(entries, hookCommand, 'claude');
    if (cleaned !== entries) {
      entries = cleaned;
      changed = true;
    }
    if (hasHook(entries, hookCommand)) {
      hooks[event] = entries;
      continue;
    }
    entries.push({ hooks: [{ type: 'command', command: hookCommand }] });
    hooks[event] = entries;
    changed = true;
  }

  if (!changed) {
    return { changed: false, configured: events.every((e) => hasHook(hooks[e] ?? [], hookCommand)) };
  }

  settings.hooks = hooks;
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { changed: true, configured: true };
}

export async function isClaudeHookConfigured(notifyPath: string): Promise<boolean> {
  const settingsPath = claudeSettingsPath();
  const hookCommand = buildHookCommand(notifyPath, 'claude');
  const existing = await readJson(settingsPath);
  if (!existing?.hooks) return false;
  const hooks = existing.hooks as Record<string, HookEntry[]>;
  return CLAUDE_HOOK_EVENTS.every((event) => hasHook(hooks[event] ?? [], hookCommand));
}

export async function setupClaudeHook(
  dataDir: string,
): Promise<{ notifyPath: string; hookOk: boolean }> {
  const notifyPath = await writeNotifyScript(dataDir);
  let hookOk = false;
  try {
    const res = await upsertClaudeHook(notifyPath);
    hookOk = res.configured;
  } catch {
    hookOk = false;
  }
  return { notifyPath, hookOk };
}

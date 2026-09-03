import { homedir, platform } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';

export const DEFAULT_DATA_DIR = join(homedir(), '.ai-usage');
export const DEFAULT_PORT = 8452;
/** Background syncAll interval for all sources (including Claude/Codex when hooks fail). */
export const POLL_INTERVAL_MS = 60_000;
/** Pause between scanning each channel during staggered poll/startup sync. */
export const SYNC_SOURCE_GAP_MS = 1_000;
/** Background poll hits cursor.com at most this often (manual/hook sync always fetches). */
export const CURSOR_POLL_MIN_FETCH_INTERVAL_MS = 5 * 60_000;
/** Idle-backoff ladder for background polling: 1min → 2min → 5min (cap). */
export const POLL_BACKOFF_LADDER_MS = [POLL_INTERVAL_MS, 2 * 60_000, 5 * 60_000] as const;
/** Consecutive empty poll rounds at one level before escalating to the next. */
export const POLL_BACKOFF_EMPTY_ROUNDS_PER_LEVEL = 3;
export const NOTIFY_THROTTLE_MS = 20_000;
export const LOG_MAX_BYTES = 1_000_000;

/** Whole seconds used by sync-status API payloads. */
export function pollIntervalSeconds(): number {
  return Math.max(1, Math.round(POLL_INTERVAL_MS / 1000));
}

/** Chinese label for user-facing poll hints, e.g. `1 分钟` / `30 秒`. */
export function pollIntervalLabel(): string {
  const sec = pollIntervalSeconds();
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  return `${min} 分钟`;
}

export function resolveDataDir(override?: string): string {
  if (override?.trim()) {
    const d = override.trim();
    return d.startsWith('~') ? join(homedir(), d.slice(1)) : d;
  }
  return DEFAULT_DATA_DIR;
}

export function configPath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

/** Desktop/CLI liveness stamp written while a runtime is healthy. */
export function heartbeatPath(dataDir: string): string {
  return join(dataDir, 'tud.heartbeat');
}

/** Last successfully fetched remote pricing overlay (not the bundled table). */
export function pricingOverlayPath(dataDir: string): string {
  return join(dataDir, 'pricing-overlay.json');
}

export function cursorsPath(dataDir: string): string {
  return join(dataDir, 'cursors.json');
}

export function queueDir(dataDir: string): string {
  return join(dataDir, 'queue');
}

export function cacheDir(dataDir: string): string {
  return join(dataDir, 'cache');
}

/** Sealed (closed-day) daily aggregate cache under ~/.ai-usage/cache/. */
export function sealedDailyCachePath(dataDir: string): string {
  return join(cacheDir(dataDir), 'daily-sealed.json');
}

export function manifestPath(dataDir: string): string {
  return join(queueDir(dataDir), 'manifest.json');
}

export function notifyScriptPath(dataDir: string): string {
  const name = process.platform === 'win32' ? 'notify.cmd' : 'notify.sh';
  return join(dataDir, 'bin', name);
}

/** Windows PowerShell body paired with notify.cmd. */
export function notifyPs1Path(dataDir: string): string {
  return join(dataDir, 'bin', 'notify.ps1');
}

/** Legacy Node notify path (removed after native script migration). */
export function notifyScriptPathLegacy(dataDir: string): string {
  return join(dataDir, 'bin', 'notify.mjs');
}

export function logsDir(dataDir: string): string {
  return join(dataDir, 'logs');
}

export function syncDonePath(dataDir: string): string {
  return join(dataDir, 'sync.done');
}

export function notifySignalPath(dataDir: string): string {
  return join(dataDir, 'notify.signal');
}

export function notifyLogPath(dataDir: string): string {
  return join(logsDir(dataDir), 'notify.log');
}

export function syncLogPath(dataDir: string): string {
  return join(logsDir(dataDir), 'sync.log');
}

export function uploadLogPath(dataDir: string): string {
  return join(logsDir(dataDir), 'upload.log');
}

export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function hasClaudeProjectsDir(root: string): boolean {
  try {
    return statSync(join(root, 'projects')).isDirectory();
  } catch {
    return false;
  }
}

/** Claude Code CLI (+ XDG / CLAUDE_CONFIG_DIR / ~/.claude-* profiles) project JSONL roots. */
export function claudeCliProjectsDirs(): string[] {
  const home = homedir();
  const roots = [join(home, '.claude'), join(home, '.config', 'claude')];
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg) {
    const custom = expandHomePath(cfg);
    if (!roots.includes(custom)) roots.push(custom);
  }
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!/^\.claude-.+/.test(entry.name)) continue;
      const candidate = join(home, entry.name);
      if (hasClaudeProjectsDir(candidate) && !roots.includes(candidate)) {
        roots.push(candidate);
      }
    }
  } catch {
    // Default/configured roots remain usable if home discovery fails.
  }
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const root of roots) {
    const projects = join(root, 'projects');
    if (seen.has(projects)) continue;
    seen.add(projects);
    dirs.push(projects);
  }
  return dirs;
}

/**
 * Claude.app (Cowork / local-agent) keeps isolated Claude Code sessions under
 * Application Support. Those sandboxes do not read ~/.claude/settings.json, so
 * CLI hooks never fire — we discover their projects/ dirs for passive parse.
 */
export function claudeDesktopAppSupportRoots(): string[] {
  const plat = platform();
  const names = ['Claude', 'Claude-3p'];
  if (plat === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support');
    return names.map((name) => join(base, name));
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return names.map((name) => join(appData, name));
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return names.map((name) => join(xdg, name));
}

const DESKTOP_SESSIONS_DIRS = ['local-agent-mode-sessions', 'claude-code-sessions'];
/** Bound walk depth under Desktop session trees (sessions nest ~4–6 levels). */
const DESKTOP_PROJECTS_MAX_DEPTH = 8;

const SKIP_DIR_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'IndexedDB',
  'Local Storage',
  'Session Storage',
  'blob_storage',
  'Partitions',
  'node_modules',
]);

function collectClaudeDesktopProjectsDirs(root: string, depth: number, out: string[]): void {
  if (depth > DESKTOP_PROJECTS_MAX_DEPTH || !existsSync(root)) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(root, entry.name);
    // Session sandbox layout: …/.claude/projects
    if (entry.name === 'projects' && basename(root) === '.claude') {
      out.push(full);
      continue;
    }
    collectClaudeDesktopProjectsDirs(full, depth + 1, out);
  }
}

/**
 * Discover nested .claude/projects under Claude.app session trees
 * (`local-agent-mode-sessions` and `claude-code-sessions`). Returns only
 * existing directories.
 */
export function claudeDesktopProjectsDirs(): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const appRoot of claudeDesktopAppSupportRoots()) {
    for (const sessionDir of DESKTOP_SESSIONS_DIRS) {
      const sessionsRoot = join(appRoot, sessionDir);
      if (!existsSync(sessionsRoot)) continue;
      const collected: string[] = [];
      collectClaudeDesktopProjectsDirs(sessionsRoot, 0, collected);
      for (const dir of collected) {
        if (seen.has(dir)) continue;
        try {
          if (statSync(dir).isDirectory()) {
            seen.add(dir);
            found.push(dir);
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return found;
}

/** All Claude JSONL project roots: CLI + Desktop Cowork/local-agent. */
export function claudeProjectsDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [...claudeCliProjectsDirs(), ...claudeDesktopProjectsDirs()]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

export function codexHome(): string {
  return codexHomeCandidates()[0]!;
}

function expandCodexHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Codex-compatible config roots that may contain session rollouts.
 *
 * CC Switch can run Codex with a custom config directory when switching
 * providers/accounts. Keep the normal CODEX_HOME override, but also discover
 * additional roots so historical sessions from another official account are
 * not silently omitted. `CODEX_HOME` and `AI_USAGE_CODEX_HOME` accept the
 * platform path-list separator for users who keep several profiles.
 */
export function codexHomeCandidates(): string[] {
  const delimiter = platform() === 'win32' ? ';' : ':';
  const roots: string[] = [];
  const add = (value: string | undefined): boolean => {
    if (!value?.trim()) return false;
    let added = false;
    for (const part of value.split(delimiter)) {
      const expanded = expandCodexHomePath(part);
      if (expanded) {
        added = true;
        if (!roots.includes(expanded)) roots.push(expanded);
      }
    }
    return added;
  };

  const hasUsageHomeEnv = add(process.env.AI_USAGE_CODEX_HOME);
  const hasCodexHomeEnv = add(process.env.CODEX_HOME);
  const hasExplicitEnvRoot = hasUsageHomeEnv || hasCodexHomeEnv;
  let hasCcSwitchOverride = false;

  // CC Switch stores its directory override in this small, non-secret JSON
  // settings file. Ignore malformed/unreadable files and keep defaults.
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), '.cc-switch', 'settings.json'), 'utf8'),
    ) as { codexConfigDir?: unknown; codex_config_dir?: unknown };
    if (typeof settings.codexConfigDir === 'string') {
      hasCcSwitchOverride = add(settings.codexConfigDir) || hasCcSwitchOverride;
    }
    if (typeof settings.codex_config_dir === 'string') {
      hasCcSwitchOverride = add(settings.codex_config_dir) || hasCcSwitchOverride;
    }
  } catch {
    // CC Switch is optional; an absent or old settings file is expected.
  }

  // An explicit environment override is authoritative (and is important for
  // test isolation). When CC Switch has a saved alternate directory, retain
  // the default root as well so old sessions remain visible after switching.
  if (!hasExplicitEnvRoot || hasCcSwitchOverride) add(join(homedir(), '.codex'));
  return roots;
}

export function codexSessionsDirs(): string[] {
  const dirs: string[] = [];
  for (const home of codexHomeCandidates()) {
    for (const name of ['sessions', 'archived_sessions']) {
      const dir = join(home, name);
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

export function codexHooksJsonPath(): string {
  return join(codexHome(), 'hooks.json');
}

export function codexNotifyOriginalPath(dataDir: string): string {
  return join(dataDir, 'hooks', 'codex-notify-original.json');
}

function cursorAppDir(): string {
  const plat = platform();
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor');
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor');
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdg, 'Cursor');
}

export function cursorStateVscdbPath(): string {
  const explicit = process.env.CURSOR_STATE_DB_PATH?.trim();
  if (explicit) {
    return explicit.startsWith('~') ? join(homedir(), explicit.slice(1)) : explicit;
  }
  return join(cursorAppDir(), 'User', 'globalStorage', 'state.vscdb');
}

export function cursorCliConfigPath(): string {
  return join(homedir(), '.cursor', 'cli-config.json');
}

function appSupportBase(): string {
  const plat = platform();
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support');
  }
  if (plat === 'win32') {
    return process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

/** Electron Application Support folder names for Qoder IDE (intl + CN). */
export function qoderIdeAppSupportNames(): string[] {
  return ['Qoder', 'QoderCN'];
}

export type QoderIdeVariant = {
  collector: 'qoder-ide' | 'qoder-cn-ide';
  appSupportName: string;
};

export function qoderIdeVariants(): QoderIdeVariant[] {
  return [
    { collector: 'qoder-ide', appSupportName: 'Qoder' },
    { collector: 'qoder-cn-ide', appSupportName: 'QoderCN' },
  ];
}

/** Path to SharedClientCache/cache/db/local.db for a Qoder IDE variant. */
export function qoderIdeLocalDbPath(appSupportName: string): string {
  return join(
    appSupportBase(),
    appSupportName,
    'SharedClientCache',
    'cache',
    'db',
    'local.db',
  );
}

export function qoderIdeLocalDbEntries(): Array<{
  collector: 'qoder-ide' | 'qoder-cn-ide';
  dbPath: string;
}> {
  return qoderIdeVariants().map((v) => ({
    collector: v.collector,
    dbPath: qoderIdeLocalDbPath(v.appSupportName),
  }));
}

/** Qoder CLI transcript roots (`~/.qoder/projects`). */
export function qoderCliProjectsDirs(): string[] {
  return [join(homedir(), '.qoder', 'projects')];
}

/** Qoder Work transcript roots (`~/.qoderwork/projects`). */
export function qoderWorkProjectsDirs(): string[] {
  return [join(homedir(), '.qoderwork', 'projects')];
}

export type TraeVariant = {
  collector: 'trae-ide' | 'trae-cn-ide';
  appSupportName: string;
};

export function traeVariants(): TraeVariant[] {
  return [
    { collector: 'trae-ide', appSupportName: 'Trae' },
    { collector: 'trae-cn-ide', appSupportName: 'Trae CN' },
  ];
}

/** Encrypted AI-agent database for Trae / Trae CN. */
export function traeAgentDbPath(appSupportName: string): string {
  return join(
    appSupportBase(),
    appSupportName,
    'ModularData',
    'ai-agent',
    'database.db',
  );
}

export function traeAgentDbEntries(): Array<{
  collector: 'trae-ide' | 'trae-cn-ide';
  dbPath: string;
}> {
  return traeVariants().map((v) => ({
    collector: v.collector,
    dbPath: traeAgentDbPath(v.appSupportName),
  }));
}

/** Cached SQLCipher raw keys (0600), one file per Trae collector. */
export function traeSqlcipherKeyPath(dataDir: string, collector: string): string {
  return join(dataDir, 'trae-keys', `${collector}.json`);
}

/** Gemini CLI session temp root (`~/.gemini/tmp` or `$GEMINI_HOME/tmp`). */
export function geminiHome(): string {
  const env = process.env.GEMINI_HOME?.trim();
  if (env) {
    return env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
  }
  return join(homedir(), '.gemini');
}

export function geminiTmpDir(): string {
  return join(geminiHome(), 'tmp');
}

/** OpenCode data root (`~/.local/share/opencode` or `$OPENCODE_HOME`). */
export function opencodeDataDir(): string {
  const env = process.env.OPENCODE_HOME?.trim();
  if (env) {
    return env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) {
    const base = xdg.startsWith('~') ? join(homedir(), xdg.slice(1)) : xdg;
    return join(base, 'opencode');
  }
  return join(homedir(), '.local', 'share', 'opencode');
}

export function opencodeDbPath(): string {
  return join(opencodeDataDir(), 'opencode.db');
}

export function opencodeMessagesDir(): string {
  return join(opencodeDataDir(), 'storage', 'message');
}

/** GitHub Copilot CLI session-state root (`~/.copilot/session-state`). */
export function copilotHome(): string {
  const env = process.env.COPILOT_HOME?.trim();
  if (env) {
    return env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
  }
  return join(homedir(), '.copilot');
}

export function copilotSessionStateDir(): string {
  return join(copilotHome(), 'session-state');
}

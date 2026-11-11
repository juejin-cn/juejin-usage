import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { IntegrationEnvironment, IntegrationTool } from './adapters.js';

export interface ToolInstallation { kind: 'cli' | 'app' | 'extension'; path: string }
const COMMANDS: Partial<Record<IntegrationTool, string[]>> = {
  t3code: ['t3code'], 'copilot-cli': ['copilot'], omp: ['omp'], 'kimi-code': ['kimi'], qoder: ['qodercli'], 'grok-build': ['grok'],
  gemini: ['gemini'], claude: ['claude'], codex: ['codex'], opencode: ['opencode'], 'minimax-code': ['mcode'],
  'deepseek-harness': ['dsh'], pi: ['pi'], zcode: ['zcode'], 'cursor-cli': ['cursor-agent', 'agent'],
};

/** Installation evidence is a runnable file, never an old settings directory. */
export async function isExecutable(file: string, platform: string, extensions = '.EXE;.CMD;.BAT;.COM'): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform === 'win32') return extensions.split(';').some(extension => extension && file.toLowerCase().endsWith(extension.toLowerCase()));
    await access(file, constants.X_OK);
    return true;
  } catch { return false; }
}

export function executableDirectories(environment: IntegrationEnvironment, shellPath = ''): string[] {
  const { home, platform, env } = environment;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  const directories = [
    ...(env.PATH ?? env.Path ?? '').split(delimiter), ...shellPath.split(delimiter),
    env.PNPM_HOME, env.VOLTA_HOME ? p.join(env.VOLTA_HOME, 'bin') : undefined,
    prefix ? (platform === 'win32' ? prefix : p.join(prefix, 'bin')) : undefined,
    p.join(home, '.local', 'bin'), p.join(home, '.bun', 'bin'), p.join(home, '.cargo', 'bin'),
    p.join(home, '.volta', 'bin'), p.join(home, '.npm-global', 'bin'), p.join(home, '.opencode', 'bin'),
    p.join(home, '.minimax-code', 'bin'),
    ...(platform === 'win32' ? [
      p.join(env.APPDATA ?? p.join(home, 'AppData', 'Roaming'), 'npm'),
      p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'pnpm'),
      p.join(home, 'scoop', 'shims'),
    ] : [p.join(home, '.local', 'share', 'pnpm'), ...(env.PATH ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] : [])]),
  ];
  // Empty/relative PATH entries must not resolve tools from the project cwd.
  return [...new Set(directories.filter((directory): directory is string => Boolean(directory)).map(directory => directory.replace(/^"(.*)"$/, '$1')).filter(directory => p.isAbsolute(directory)))];
}

/** GUI launchers miss shell-only node/pnpm prefixes. Resolve PATH once, with a
 * bounded cache; do not launch the tools themselves or inspect their accounts.
 * Discovery approach informed by Multica's agents_probe.go. */
export class ToolDetector {
  private shellCache?: { until: number; value: Promise<string> };
  constructor(private environment: IntegrationEnvironment, private resolveShell: () => Promise<string> = () => loginShellPath(environment)) {}
  reset() { this.shellCache = undefined; }
  private shellPath(): Promise<string> {
    if (!this.shellCache || this.shellCache.until < Date.now()) this.shellCache = { until: Date.now() + 60_000, value: this.resolveShell().catch(() => '') };
    return this.shellCache.value;
  }
  private async command(id: IntegrationTool, directories: string[]): Promise<ToolInstallation | null> {
    const { platform, env } = this.environment;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const extensions = env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
    const suffixes = platform === 'win32' ? [...new Set(extensions.split(';').filter(Boolean).flatMap(extension => [extension.toLowerCase(), extension.toUpperCase()]))] : [''];
    for (const directory of directories) for (const command of COMMANDS[id] ?? []) for (const suffix of suffixes) {
      const candidate = p.join(directory, command + suffix);
      if (await isExecutable(candidate, platform, extensions)) return { kind: 'cli', path: candidate };
    }
    return null;
  }
  private async application(names: string[]): Promise<ToolInstallation | null> {
    const { home, platform, env } = this.environment;
    const p = platform === 'win32' ? path.win32 : path.posix;
    if (platform === 'darwin') {
      for (const root of [p.join(home, 'Applications'), '/Applications']) for (const name of names) {
        const bundle = p.join(root, name + '.app');
        const bin = p.join(bundle, 'Contents', 'MacOS');
        try {
          for (const file of await readdir(bin)) if (await isExecutable(p.join(bin, file), platform)) return { kind: 'app', path: bundle };
        } catch { /* No app bundle or no runnable entrypoint. */ }
      }
    } else if (platform === 'win32') {
      const local = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local');
      const roots = [p.join(local, 'Programs'), local, env.ProgramFiles, env['ProgramFiles(x86)']].filter((root): root is string => Boolean(root));
      for (const root of roots) for (const name of names) for (const executable of [name, name.toLowerCase()]) {
        const file = p.join(root, name, executable + '.exe');
        if (await isExecutable(file, platform)) return { kind: 'app', path: file };
      }
    }
    return null;
  }
  private async extension(): Promise<ToolInstallation | null> {
    const { home, platform } = this.environment;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const root = p.join(home, '.vscode', 'extensions');
    let obsolete: Record<string, unknown> = {};
    try { obsolete = JSON.parse(await readFile(p.join(root, '.obsolete'), 'utf8')); } catch { /* Normal without removed extensions. */ }
    try {
      for (const name of await readdir(root)) {
        if (!name.startsWith('anthropic.claude-code-') || obsolete?.[name]) continue;
        try {
          const file = p.join(root, name, 'package.json');
          const manifest = JSON.parse(await readFile(file, 'utf8'));
          if (manifest.publisher?.toLowerCase() === 'anthropic' && manifest.name === 'claude-code') return { kind: 'extension', path: p.dirname(file) };
        } catch { /* Incomplete install. */ }
      }
    } catch { /* VS Code extensions not installed. */ }
    return null;
  }
  async detect(id: IntegrationTool): Promise<ToolInstallation | null> {
    if (id === 'claude-vscode') return this.extension();
    if (COMMANDS[id]) {
      const direct = await this.command(id, executableDirectories(this.environment));
      if (direct) return direct;
      const shell = await this.shellPath();
      if (shell) {
        const found = await this.command(id, executableDirectories(this.environment, shell));
        if (found) return found;
      }
    }
    const apps: Partial<Record<IntegrationTool, string[]>> = { t3code: ['T3 Code', 'T3Code'], antigravity: ['Antigravity'], zcode: ['ZCode', 'Zcode'], 'claude-desktop': ['Claude'], 'deepseek-harness': ['DeepSeek Harness', 'deepseek-harness'], trae: ['TRAE', 'Trae'], 'cursor-ide': ['Cursor'] };
    return apps[id] ? this.application(apps[id]!) : null;
  }
}

function loginShellPath({ env, home, platform }: IntegrationEnvironment): Promise<string> {
  const shell = env.SHELL;
  if (platform === 'win32' || !shell || !path.posix.isAbsolute(shell) || !['zsh', 'bash', 'sh', 'dash', 'fish', 'ksh'].includes(path.posix.basename(shell))) return Promise.resolve('');
  const pathExpression = path.posix.basename(shell) === 'fish' ? '(string join : $PATH)' : '"$PATH"';
  return new Promise(resolve => {
    execFile(shell, ['-ilc', `printf '\\n__JUSAGE_TOOL_PATH__%s\\n' ${pathExpression}`], { env: { ...env, HOME: home }, cwd: home, timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(''); return; }
      resolve(stdout.split(/\r?\n/).find(line => line.startsWith('__JUSAGE_TOOL_PATH__'))?.slice('__JUSAGE_TOOL_PATH__'.length) ?? '');
    });
  });
}

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Finder-launched apps receive a deliberately small PATH. npm and pnpm CLIs
 * are shell wrappers that invoke `node`, so locating the wrapper alone is not
 * enough for a GUI process.
 */
export function prependGuiNodePaths(currentPath: string | undefined, home = homedir()): string {
  if (process.platform === 'win32') return currentPath ?? '';
  const candidates = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.mise', 'shims'),
  ];
  const addVersionBins = (root: string, suffix: readonly string[]) => {
    try {
      candidates.push(...readdirSync(root)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((version) => path.join(root, version, ...suffix))
        .filter((directory) => existsSync(path.join(directory, 'node'))));
    } catch {
      // The corresponding Node version manager is not installed.
    }
  };
  addVersionBins(path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']);
  addVersionBins(path.join(home, '.nvm', 'versions', 'node'), ['bin']);

  const seen = new Set<string>();
  return [...candidates, ...(currentPath ?? '').split(path.delimiter)]
    .filter((directory) => directory && !seen.has(directory) && (seen.add(directory), true))
    .join(path.delimiter);
}

/** Environment for a local agent CLI launched by the Desktop main process. */
export function guiCliEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: prependGuiNodePaths(process.env.PATH) };
}

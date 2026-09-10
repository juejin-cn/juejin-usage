import { join } from 'node:path';

/**
 * Where an Electron app keeps its data under `home`, per platform.
 *
 * Mirrors `appSupportBase()` / `claudeDesktopAppSupportRoots()` in
 * `src/paths.ts`. Fixtures that hard-code the macOS
 * `~/Library/Application Support` layout only ever exercise the darwin branch,
 * so they fail on Linux and Windows even though the parser is fine there.
 */
export function appSupportDir(home: string, ...segments: string[]): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', ...segments);
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Roaming', ...segments);
  }
  return join(home, '.config', ...segments);
}

/**
 * Point every home-derived lookup in `src/paths.ts` at `home`, and return a
 * function that restores the previous environment.
 *
 * `HOME` / `USERPROFILE` cover `os.homedir()`. `APPDATA` and `XDG_CONFIG_HOME`
 * matter too: `appSupportBase()` and `claudeDesktopAppSupportRoots()` read them
 * *before* falling back to the home directory, so without pinning them a
 * fixture still resolves to the real user profile on Windows, and on any Linux
 * box that exports `XDG_CONFIG_HOME`.
 */
export function pinHomeEnv(home: string): () => void {
  const pinned: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(pinned)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

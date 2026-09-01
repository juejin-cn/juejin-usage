import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveAntigravityBrainDirs } from '../parsers/antigravity.js';
import { resolveAmpThreadsDir } from '../parsers/amp.js';
import { resolveCodebuddyHome } from '../parsers/codebuddy.js';
import { droidSessionsDirs } from '../parsers/droid.js';
import { deepseekSessionsDir } from '../parsers/deepseek.js';
import { everyCodeHome } from '../parsers/every-code.js';
import { gooseDbPath } from '../parsers/goose.js';
import { resolveGrokBuildHome } from '../parsers/grok.js';
import { hermesHome } from '../parsers/hermes.js';
import { kiloCliDbPath } from '../parsers/kilo-cli.js';
import { kiroCliDbPath, kiroCliSessionsDir } from '../parsers/kiro.js';
import { mimoDbPath } from '../parsers/mimo.js';
import { ompAgentDirCollidesWithPi, ompSessionsDir } from '../parsers/omp.js';
import { openclawRoots } from '../parsers/openclaw.js';
import { piSessionsDir } from '../parsers/pi.js';
import { qwenTmpDir } from '../parsers/qwen.js';
import { resolveWorkbuddyHome } from '../parsers/workbuddy.js';
import { zcodeDbPath } from '../parsers/zcode.js';
import { zedDbPath } from '../parsers/zed.js';
import { warpDbPaths } from '../parsers/warp.js';
import {
  codexHome,
  copilotSessionStateDir,
  cursorStateVscdbPath,
  geminiTmpDir,
  opencodeDbPath,
  opencodeMessagesDir,
  qoderCliProjectsDirs,
  qoderIdeLocalDbEntries,
  qoderWorkProjectsDirs,
  traeAgentDbEntries,
} from '../paths.js';

function anyExists(paths: Array<string | null | undefined>): boolean {
  for (const p of paths) {
    if (p && existsSync(p)) return true;
  }
  return false;
}

function vscodeGlobalStorageRoots(): string[] {
  const home = homedir();
  const plat = process.platform;
  const hosts =
    plat === 'darwin'
      ? [
          join(home, 'Library', 'Application Support', 'Code'),
          join(home, 'Library', 'Application Support', 'Cursor'),
          join(home, 'Library', 'Application Support', 'Code - Insiders'),
        ]
      : plat === 'win32'
        ? [
            join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Code'),
            join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor'),
          ]
        : [
            join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Code'),
            join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor'),
          ];
  return hosts.map((h) => join(h, 'User', 'globalStorage'));
}

/**
 * Cheap presence gate before running a source parser.
 * Returns false when local install / data dirs are clearly missing.
 * Claude always returns true (empty projects dir is common).
 */
export function isSyncSourcePresent(source: string): boolean {
  switch (source) {
    case 'claude':
      // Empty ~/.claude/projects is common; still attempt parse (cheap when empty).
      return true;
    case 'codex':
      return anyExists([codexHome(), join(codexHome(), 'sessions')]);
    case 'cursor':
      return anyExists([cursorStateVscdbPath()]);
    case 'qoder':
      return anyExists([
        ...qoderIdeLocalDbEntries().map((e) => e.dbPath),
        ...qoderCliProjectsDirs(),
        ...qoderWorkProjectsDirs(),
      ]);
    case 'trae':
      return anyExists(traeAgentDbEntries().map((e) => e.dbPath));
    case 'gemini':
      return anyExists([geminiTmpDir()]);
    case 'opencode':
      return anyExists([opencodeDbPath(), opencodeMessagesDir()]);
    case 'copilot':
      return anyExists([copilotSessionStateDir()]);
    case 'antigravity':
      return anyExists(resolveAntigravityBrainDirs());
    case 'openclaw':
      return anyExists(openclawRoots());
    case 'hermes':
      return anyExists([hermesHome()]);
    case 'zcode':
      return anyExists([zcodeDbPath()]);
    case 'pi':
      return anyExists([piSessionsDir()]);
    case 'kimi': {
      const home = homedir();
      return anyExists([
        process.env.KIMI_CODE_HOME,
        process.env.KIMI_HOME,
        join(home, '.kimi-code'),
        join(home, '.kimi'),
      ]);
    }
    case 'roocode':
      return anyExists(
        vscodeGlobalStorageRoots().map((r) =>
          join(r, 'rooveterinaryinc.roo-cline', 'tasks'),
        ),
      );
    case 'droid':
      return anyExists(droidSessionsDirs());
    case 'kiro':
      return anyExists([kiroCliSessionsDir(), kiroCliDbPath()]);
    case 'cline':
      return anyExists(
        vscodeGlobalStorageRoots().map((r) =>
          join(r, 'saoudrizwan.claude-dev'),
        ),
      );
    case 'amp':
      return anyExists([resolveAmpThreadsDir()]);
    case 'qwen':
      return anyExists([qwenTmpDir()]);
    case 'codebuddy':
      return anyExists([
        resolveCodebuddyHome(),
        join(resolveCodebuddyHome(), 'projects'),
      ]);
    case 'workbuddy':
      return anyExists([
        resolveWorkbuddyHome(),
        join(resolveWorkbuddyHome(), 'projects'),
        join(resolveWorkbuddyHome(), 'workbuddy.db'),
      ]);
    case 'grok':
      return anyExists([
        resolveGrokBuildHome(),
        join(resolveGrokBuildHome(), 'sessions'),
      ]);
    case 'mimo':
      return anyExists([mimoDbPath()]);
    case 'every-code':
      return anyExists([
        everyCodeHome(),
        join(everyCodeHome(), 'sessions'),
      ]);
    case 'omp':
      if (ompAgentDirCollidesWithPi()) return false;
      return anyExists([ompSessionsDir()]);
    case 'kilo-cli':
      return anyExists([kiloCliDbPath()]);
    case 'kilocode':
      return anyExists(
        vscodeGlobalStorageRoots().map((r) =>
          join(r, 'kilocode.kilo-code', 'tasks'),
        ),
      );
    case 'goose':
      return anyExists([gooseDbPath()]);
    case 'zed':
      return anyExists([zedDbPath()]);
    case 'warp':
      return anyExists(warpDbPaths());
    case 'deepseek':
      return anyExists([deepseekSessionsDir()]);
    default:
      return true;
  }
}

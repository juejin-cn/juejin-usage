import { mkdir, writeFile } from 'node:fs/promises';
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
 * `HOME` / `USERPROFILE` cover `os.homedir()`. The XDG and `APPDATA` bases
 * matter too: `appSupportBase()`, `claudeDesktopAppSupportRoots()` and the
 * `~/.local/share` lookups read them *before* falling back to the home
 * directory, so without pinning them a fixture still resolves to the real user
 * profile on Windows, and on any Linux box that exports them.
 */
export function pinHomeEnv(home: string): () => void {
  const pinned: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
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

/**
 * Per-agent path overrides in `src/paths.ts` and `src/parsers/*`. Each one wins
 * over the home directory, so a developer who exports any of them would have
 * their real transcripts scanned by a test that only pinned `HOME`.
 *
 * Add new entries here when a parser gains its own override.
 */
const AGENT_PATH_OVERRIDE_ENV = [
  'AI_USAGE_CLINE_ROOTS',
  'AI_USAGE_EVERY_CODE_HOME',
  'AI_USAGE_KILOCODE_ROOTS',
  'AI_USAGE_OMP_AGENT_DIR',
  'AI_USAGE_VSCODE_ROOTS',
  'AMP_DATA_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CODE_HOME',
  'COPILOT_HOME',
  'CURSOR_STATE_DB_PATH',
  'DROID_SESSIONS_DIR',
  'FACTORY_DIR',
  'GEMINI_HOME',
  'HERMES_HOME',
  'KILO_CLI_DB',
  'KILO_HOME',
  'KIMI_CODE_HOME',
  'KIMI_HOME',
  'KIRO_CLI_DB_PATH',
  'KIRO_CLI_SESSIONS_DIR',
  'KIRO_HOME',
  'MIMO_DB_PATH',
  'MIMO_HOME',
  'OMP_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCODE_HOME',
  'PI_CODING_AGENT_DIR',
  'QWEN_TMP_DIR',
  'ZCODE_HOME',
] as const;

/**
 * Sandbox a whole sync round: `pinHomeEnv(home)` plus every per-agent override
 * cleared, so the only agent data reachable is what the test seeded under
 * `home`.
 *
 * Tests that drive `syncAll` / `syncAllStaggered` need this. Without it they
 * walk the developer's real `~/.claude`, `~/.codex`, … — slow (a 500 MB
 * transcript tree takes ~60 s), non-deterministic (the result depends on which
 * agents that machine has installed) and, once Cursor's `state.vscdb` is
 * present, the cursor channel will read its access token and hit cursor.com for
 * real, because the fetch throttle only kicks in once `lastSyncAt` exists and a
 * fresh temp dataDir has none.
 */
export function isolateAgentHome(home: string): () => void {
  const restoreHome = pinHomeEnv(home);
  const previous = new Map<string, string | undefined>();
  for (const name of AGENT_PATH_OVERRIDE_ENV) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    restoreHome();
  };
}

/** One assistant turn in a Claude Code CLI transcript under `home`. */
export const SEEDED_CLAUDE = {
  model: 'claude-sonnet-4-6',
  project: 'app',
  inputTokens: 100,
  outputTokens: 20,
  events: 1,
};

export async function seedClaudeSession(home: string): Promise<void> {
  const projectDir = join(home, '.claude', 'projects', '-Users-dev-app');
  await mkdir(projectDir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-06-09T20:46:30.000Z',
    requestId: 'req_seed_claude',
    message: {
      id: 'msg_seed_claude',
      model: SEEDED_CLAUDE.model,
      usage: {
        input_tokens: SEEDED_CLAUDE.inputTokens,
        output_tokens: SEEDED_CLAUDE.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  await writeFile(join(projectDir, 'session.jsonl'), `${line}\n`, 'utf8');
}

/** One token_count event in a Codex rollout under `home`. */
export const SEEDED_CODEX = {
  model: 'gpt-5.4',
  inputTokens: 50,
  outputTokens: 10,
  events: 1,
};

export async function seedCodexSession(home: string): Promise<void> {
  const sessionsDir = join(home, '.codex', 'sessions', '2026', '06', '09');
  await mkdir(sessionsDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-06-09T20:46:00.000Z',
      payload: { id: 'seed-codex-1', cwd: '/Users/dev/app' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-09T20:46:30.000Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: SEEDED_CODEX.inputTokens,
            cached_input_tokens: 0,
            output_tokens: SEEDED_CODEX.outputTokens,
            reasoning_output_tokens: 0,
            total_tokens: SEEDED_CODEX.inputTokens + SEEDED_CODEX.outputTokens,
          },
          model: SEEDED_CODEX.model,
        },
      },
    }),
  ];
  await writeFile(join(sessionsDir, 'rollout-seed.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

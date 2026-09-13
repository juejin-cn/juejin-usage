import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  claudeCliProjectsDirs,
  claudeDesktopProjectsDirs,
  claudeProjectsDirs,
} from '../src/paths.js';
import { listClaudeProjectFiles, parseClaudeIncremental } from '../src/parsers/claude.js';
import { resetProjectNameCache } from '../src/project-name.js';
import { appSupportDir, pinHomeEnv } from './platform-fixtures.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], {
      stdio: 'ignore',
      timeout: 2_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-05-02T09:24:36.557Z',
  requestId: 'req_desktop_1',
  message: {
    id: 'msg_desktop_1',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 50,
    },
  },
  entrypoint: 'local-agent',
});

test('claudeCliProjectsDirs includes ~/.claude/projects', () => {
  const dirs = claudeCliProjectsDirs();
  assert.ok(dirs.includes(join(homedir(), '.claude', 'projects')));
});

test('claudeDesktopProjectsDirs finds local-agent .claude/projects', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-claude-desktop-'));
  const projectFolder = join(
    appSupportDir(tempHome, 'Claude-3p'),
    'local-agent-mode-sessions',
    'acct',
    'workspace',
    'local_abc',
    '.claude',
    'projects',
    '-Users-dev-app',
  );
  const projectsDir = dirname(projectFolder);
  await mkdir(projectFolder, { recursive: true });
  await writeFile(join(projectFolder, 'session.jsonl'), `${ASSISTANT_LINE}\n`, 'utf8');

  const restoreEnv = pinHomeEnv(tempHome);

  try {
    const desktopDirs = claudeDesktopProjectsDirs();
    assert.ok(
      desktopDirs.includes(projectsDir),
      `expected ${projectsDir} in ${JSON.stringify(desktopDirs)}`,
    );

    const all = claudeProjectsDirs();
    assert.ok(all.includes(projectsDir));
  } finally {
    restoreEnv();
  }
});

test('parseClaudeIncremental reads Desktop local-agent JSONL', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-claude-parse-'));
  const projectFolder = join(
    appSupportDir(tempHome, 'Claude-3p'),
    'local-agent-mode-sessions',
    'acct',
    'workspace',
    'local_abc',
    '.claude',
    'projects',
    '-Users-dev-app',
  );
  await mkdir(projectFolder, { recursive: true });
  await writeFile(join(projectFolder, 'session.jsonl'), `${ASSISTANT_LINE}\n`, 'utf8');
  await mkdir(join(tempHome, '.claude', 'projects'), { recursive: true });

  const restoreEnv = pinHomeEnv(tempHome);
  const prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;

  try {
    const files = await listClaudeProjectFiles();
    assert.ok(
      files.some((f) => f.endsWith('session.jsonl')),
      `expected session.jsonl in ${JSON.stringify(files)}`,
    );

    const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]?.source, 'claude');
    assert.equal(result.buckets[0]?.collector, 'claude-desktop');
    assert.equal(result.buckets[0]?.model, 'claude-sonnet-4-6');
    assert.equal(result.buckets[0]?.input_tokens, 100);
    assert.equal(result.buckets[0]?.output_tokens, 20);
    assert.equal(result.buckets[0]?.cached_input_tokens, 50);
  } finally {
    restoreEnv();
    if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig;
  }
});

test(
  'parseClaudeIncremental uses git toplevel from session cwd for nested path',
  { skip: !hasGit() },
  async () => {
    resetProjectNameCache();
    const tempRoot = await mkdtemp(join(tmpdir(), 'ai-usage-claude-cwd-'));
    const repo = join(tempRoot, 'ai-usage');
    const nested = join(repo, 'apps', 'desktop');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--template='], {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });

    const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-claude-home-'));
    const projectFolder = join(
      tempHome,
      '.claude',
      'projects',
      '-Users-dev-ai-usage-apps-desktop',
    );
    await mkdir(projectFolder, { recursive: true });

    const cwdLine = JSON.stringify({
      type: 'user',
      cwd: nested,
      timestamp: '2026-05-02T09:24:30.000Z',
    });
    const assistantLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-02T09:24:36.557Z',
      requestId: 'req_cwd_1',
      message: {
        id: 'msg_cwd_1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    await writeFile(
      join(projectFolder, 'session.jsonl'),
      `${cwdLine}\n${assistantLine}\n`,
      'utf8',
    );

    const restoreEnv = pinHomeEnv(tempHome);
    const prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;

    try {
      const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
      assert.equal(result.eventsParsed, 1);
      assert.equal(result.buckets[0]?.project, 'ai-usage');
    } finally {
      restoreEnv();
      if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig;
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  },
);

test('parseClaudeIncremental reuses cached project for grown files without re-peeking cwd', async () => {
  resetProjectNameCache();
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-claude-projcache-'));
  const projectFolder = join(tempHome, '.claude', 'projects', '-Users-dev-first-app');
  await mkdir(projectFolder, { recursive: true });
  const filePath = join(projectFolder, 'session.jsonl');

  const cwdLine = JSON.stringify({
    type: 'user',
    cwd: '/Users/dev/first-app',
    timestamp: '2026-05-02T09:24:30.000Z',
  });
  const makeAssistantLine = (id: string, timestamp: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp,
      requestId: `req_${id}`,
      message: {
        id: `msg_${id}`,
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
  const firstLine = makeAssistantLine('projcache_1', '2026-05-02T09:24:36.000Z');
  await writeFile(filePath, `${cwdLine}\n${firstLine}\n`, 'utf8');

  const restoreEnv = pinHomeEnv(tempHome);
  const prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;

  try {
    const cursors = {};
    const first = await parseClaudeIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(first.result.buckets[0]?.project, 'first-app');
    assert.equal(
      (cursors as { claude?: { files: Record<string, { project?: string }> } }).claude?.files[
        filePath
      ]?.project,
      'first-app',
    );

    // Rewrite the cwd header with a same-length path and append a new usage
    // line: incremental parse must use the cached project without re-reading
    // the file head (old behavior would resolve 'other-app').
    const alteredCwdLine = cwdLine.replace('/Users/dev/first-app', '/Users/dev/other-app');
    const secondLine = makeAssistantLine('projcache_2', '2026-05-02T09:25:36.000Z');
    await writeFile(filePath, `${alteredCwdLine}\n${firstLine}\n${secondLine}\n`, 'utf8');

    const second = await parseClaudeIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]?.project, 'first-app');
  } finally {
    restoreEnv();
    if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('parseClaudeIncremental falls back to encoded path when no cwd', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-claude-nocwd-'));
  const projectFolder = join(
    tempHome,
    '.claude',
    'projects',
    '-Users-dev-my-cool-app',
  );
  await mkdir(projectFolder, { recursive: true });
  await writeFile(join(projectFolder, 'session.jsonl'), `${ASSISTANT_LINE}\n`, 'utf8');

  const restoreEnv = pinHomeEnv(tempHome);
  const prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;

  try {
    const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 1);
    // Heuristic: last `-` segment of encoded folder name
    assert.equal(result.buckets[0]?.project, 'app');
  } finally {
    restoreEnv();
    if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

function makeAssistantLine(opts: {
  id: string;
  requestId: string;
  timestamp: string;
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
  cacheCreationBreakdown?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    requestId: opts.requestId,
    message: {
      id: opts.id,
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        ...(opts.cacheCreation != null ? { cache_creation_input_tokens: opts.cacheCreation } : {}),
        cache_read_input_tokens: opts.cacheRead ?? 0,
        ...(opts.cacheCreationBreakdown ? { cache_creation: opts.cacheCreationBreakdown } : {}),
      },
    },
  });
}

async function withTempClaudeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-claude-home-'));
  const restoreEnv = pinHomeEnv(tempHome);
  const prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return await fn(tempHome);
  } finally {
    restoreEnv();
    if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig;
    rmSync(tempHome, { recursive: true, force: true });
  }
}

test('parseClaudeIncremental keeps the last streaming chunk for the same message', async () => {
  await withTempClaudeHome(async (home) => {
    const projectFolder = join(home, '.claude', 'projects', '-Users-dev-app');
    await mkdir(projectFolder, { recursive: true });
    const first = makeAssistantLine({
      id: 'msg_stream',
      requestId: 'req_stream',
      timestamp: '2026-05-02T09:24:36.000Z',
      input: 10,
      output: 2,
    });
    const last = makeAssistantLine({
      id: 'msg_stream',
      requestId: 'req_stream',
      timestamp: '2026-05-02T09:24:37.000Z',
      input: 100,
      output: 20,
    });
    await writeFile(join(projectFolder, 'session.jsonl'), `${first}\n${last}\n`, 'utf8');

    const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]?.input_tokens, 100);
    assert.equal(result.buckets[0]?.output_tokens, 20);
    assert.equal(result.buckets[0]?.conversation_count, 1);
  });
});

test('parseClaudeIncremental emits the streaming delta on a later poll', async () => {
  await withTempClaudeHome(async (home) => {
    const projectFolder = join(home, '.claude', 'projects', '-Users-dev-app');
    await mkdir(projectFolder, { recursive: true });
    const filePath = join(projectFolder, 'session.jsonl');
    const first = makeAssistantLine({
      id: 'msg_stream2',
      requestId: 'req_stream2',
      timestamp: '2026-05-02T09:24:36.000Z',
      input: 10,
      output: 2,
    });
    await writeFile(filePath, `${first}\n`, 'utf8');

    const cursors = {};
    const firstPass = await parseClaudeIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(firstPass.result.buckets[0]?.input_tokens, 10);
    assert.equal(firstPass.result.buckets[0]?.output_tokens, 2);

    const last = makeAssistantLine({
      id: 'msg_stream2',
      requestId: 'req_stream2',
      timestamp: '2026-05-02T09:24:37.000Z',
      input: 100,
      output: 20,
    });
    await writeFile(filePath, `${first}\n${last}\n`, 'utf8');

    const secondPass = await parseClaudeIncremental(cursors, '2026-01-01T00:00:00.000Z');
    assert.equal(secondPass.result.eventsParsed, 1);
    assert.equal(secondPass.result.buckets[0]?.input_tokens, 90);
    assert.equal(secondPass.result.buckets[0]?.output_tokens, 18);
    assert.equal(secondPass.result.buckets[0]?.conversation_count, 0);
  });
});

test('normalizeClaudeUsage uses cache_creation TTL split when scalar is missing', async () => {
  await withTempClaudeHome(async (home) => {
    const projectFolder = join(home, '.claude', 'projects', '-Users-dev-app');
    await mkdir(projectFolder, { recursive: true });
    const line = makeAssistantLine({
      id: 'msg_cache',
      requestId: 'req_cache',
      timestamp: '2026-05-02T09:24:36.000Z',
      input: 10,
      output: 2,
      cacheCreationBreakdown: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 7,
      },
    });
    await writeFile(join(projectFolder, 'session.jsonl'), `${line}\n`, 'utf8');

    const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.buckets[0]?.cache_creation_input_tokens, 10);
    assert.equal(result.buckets[0]?.input_tokens, 10);
    assert.equal(result.buckets[0]?.total_tokens, 22);
  });
});

test('claudeCliProjectsDirs includes XDG and ~/.claude-* profiles', async () => {
  await withTempClaudeHome(async (home) => {
    const xdgProjects = join(home, '.config', 'claude', 'projects');
    const profileProjects = join(home, '.claude-work', 'projects', '-Users-dev-work');
    await mkdir(xdgProjects, { recursive: true });
    await mkdir(profileProjects, { recursive: true });
    await writeFile(join(profileProjects, 'session.jsonl'), `${ASSISTANT_LINE}\n`, 'utf8');

    const dirs = claudeCliProjectsDirs();
    assert.ok(dirs.includes(join(home, '.claude', 'projects')));
    assert.ok(dirs.includes(xdgProjects));
    assert.ok(dirs.includes(join(home, '.claude-work', 'projects')));

    const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]?.collector, 'claude-code-cli');
  });
});

test('claudeDesktopProjectsDirs finds claude-code-sessions projects', async () => {
  await withTempClaudeHome(async (home) => {
    const projectFolder = join(
      appSupportDir(home, 'Claude'),
      'claude-code-sessions',
      'acct',
      'workspace',
      'sess_abc',
      '.claude',
      'projects',
      '-Users-dev-app',
    );
    const projectsDir = dirname(projectFolder);
    await mkdir(projectFolder, { recursive: true });
    await writeFile(join(projectFolder, 'session.jsonl'), `${ASSISTANT_LINE}\n`, 'utf8');

    const desktopDirs = claudeDesktopProjectsDirs();
    assert.ok(
      desktopDirs.includes(projectsDir),
      `expected ${projectsDir} in ${JSON.stringify(desktopDirs)}`,
    );

    const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]?.collector, 'claude-desktop');
  });
});

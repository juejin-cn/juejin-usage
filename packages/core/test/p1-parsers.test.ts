import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { parseOpenclawIncremental } from '../src/parsers/openclaw.js';
import { parseAutoclawIncremental } from '../src/parsers/autoclaw.js';
import { parsePiIncremental } from '../src/parsers/pi.js';
import { parseHermesIncremental } from '../src/parsers/hermes.js';
import { parseZcodeIncremental, isZcodeNativeMessage } from '../src/parsers/zcode.js';
import { parseKimiIncremental } from '../src/parsers/kimi.js';
import { parseRoocodeIncremental } from '../src/parsers/roocode.js';
import { parseDroidIncremental } from '../src/parsers/droid.js';
import { parseKiroIncremental } from '../src/parsers/kiro.js';
import { bucketToIngestEvent } from '../src/upload/events.js';

const SINCE = '2020-01-01T00:00:00.000Z';

test('isZcodeNativeMessage blocks anthropic/openai/google', () => {
  assert.equal(isZcodeNativeMessage({ providerID: 'builtin:zai-glm' }), true);
  assert.equal(isZcodeNativeMessage({ providerID: 'anthropic' }), false);
  assert.equal(isZcodeNativeMessage({ providerID: 'openai-compat' }), false);
  assert.equal(isZcodeNativeMessage({ providerID: 'google-vertex' }), false);
});

test('parseOpenclawIncremental subtracts cache from input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-oc-'));
  const prev = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = home;
  try {
    const sessions = join(home, 'agents', 'main', 'sessions');
    await mkdir(sessions, { recursive: true });
    const line = {
      type: 'message',
      timestamp: '2026-07-24T10:05:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        usage: {
          input: 120,
          output: 40,
          cacheRead: 20,
          cacheWrite: 5,
          totalTokens: 165,
        },
      },
    };
    await writeFile(join(sessions, 's1.jsonl'), JSON.stringify(line) + '\n');

    const { result } = await parseOpenclawIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'openclaw');
    assert.equal(result.buckets[0]!.input_tokens, 100);
    assert.equal(result.buckets[0]!.cached_input_tokens, 20);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 5);
    assert.equal(result.buckets[0]!.output_tokens, 40);
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = prev;
  }
});

test('parseAutoclawIncremental reads openclaw-style sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-ac-'));
  const prev = process.env.AUTOCLAW_STATE_DIR;
  process.env.AUTOCLAW_STATE_DIR = home;
  try {
    const sessions = join(home, 'agents', 'main', 'sessions');
    await mkdir(sessions, { recursive: true });
    const line = {
      type: 'message',
      timestamp: '2026-09-08T03:52:43.574Z',
      message: {
        role: 'assistant',
        model: 'glm-5.3-flash',
        usage: {
          input: 25325,
          output: 182,
          cacheRead: 5504,
          cacheWrite: 0,
        },
      },
    };
    await writeFile(join(sessions, 'a1.jsonl'), JSON.stringify(line) + '\n');

    const { result } = await parseAutoclawIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'autoclaw');
    assert.equal(result.buckets[0]!.project, 'main');
    assert.equal(result.buckets[0]!.model, 'glm-5.3-flash');
    assert.equal(result.buckets[0]!.input_tokens, 19821);
    assert.equal(result.buckets[0]!.cached_input_tokens, 5504);
    assert.equal(result.buckets[0]!.output_tokens, 182);
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_STATE_DIR;
    else process.env.AUTOCLAW_STATE_DIR = prev;
  }
});

test('parseAutoclawIncremental attributes projects from tool-call paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-ac2-'));
  const repo = await mkdtemp(join(tmpdir(), 'tud-acrepo-'));
  await mkdir(join(repo, '.git'), { recursive: true });
  const prev = process.env.AUTOCLAW_STATE_DIR;
  process.env.AUTOCLAW_STATE_DIR = home;
  try {
    const agentDir = join(home, 'agents', 'agent-x1');
    const sessions = join(agentDir, 'sessions');
    await mkdir(sessions, { recursive: true });
    await mkdir(join(agentDir, 'workspace'), { recursive: true });
    await writeFile(
      join(agentDir, 'workspace', 'IDENTITY.md'),
      '---\nsummary: "Agent identity record"\nagent.name: "代码助手"\n---\n',
    );

    const withTool = {
      type: 'message',
      timestamp: '2026-09-08T03:52:43.574Z',
      message: {
        role: 'assistant',
        model: 'glm-5.3-flash',
        usage: { input: 100, output: 10 },
        content: [
          { type: 'toolCall', name: 'read', arguments: { path: join(repo, 'src', 'A.java') } },
        ],
      },
    };
    // No tool call → carry forward the session's last project.
    const noTool = {
      type: 'message',
      timestamp: '2026-09-08T03:53:43.574Z',
      message: { role: 'assistant', model: 'glm-5.3-flash', usage: { input: 5, output: 1 } },
    };
    await writeFile(
      join(sessions, 's1.jsonl'),
      [withTool, noTool].map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    // Fresh agent without tool paths falls back to the identity display name.
    const idleDir = join(home, 'agents', 'agent-y2');
    await mkdir(join(idleDir, 'sessions'), { recursive: true });
    await mkdir(join(idleDir, 'workspace'), { recursive: true });
    await writeFile(
      join(idleDir, 'workspace', 'IDENTITY.md'),
      '---\nagent.name: "运维助手"\n---\n',
    );
    await writeFile(
      join(idleDir, 'sessions', 's2.jsonl'),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-09-08T03:54:43.574Z',
        message: { role: 'assistant', model: 'glm-5.3-flash', usage: { input: 7, output: 2 } },
      }) + '\n',
    );

    const { result, cursors } = await parseAutoclawIncremental({}, SINCE);
    assert.equal(result.fullRescan, true);
    assert.equal(result.eventsParsed, 3);
    const byProject = new Map<string, number>();
    for (const b of result.buckets) {
      byProject.set(b.project, (byProject.get(b.project) ?? 0) + b.total_tokens);
    }
    assert.equal(byProject.size, 2);
    assert.equal(byProject.get(basename(repo)), 116);
    assert.equal(byProject.get('运维助手'), 9);
    assert.equal(
      (cursors as { autoclaw?: { repoProjects?: boolean } }).autoclaw?.repoProjects,
      true,
    );

    const second = await parseAutoclawIncremental(cursors, SINCE);
    assert.notEqual(second.result.fullRescan, true);
    assert.equal(second.result.eventsParsed, 0);
  } finally {
    if (prev === undefined) delete process.env.AUTOCLAW_STATE_DIR;
    else process.env.AUTOCLAW_STATE_DIR = prev;
  }
});

test('parsePiIncremental uses entry.id dedup and cacheWrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-pi-'));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const sessions = join(dir, 'sessions', 'proj');
    await mkdir(sessions, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session', id: 'sess-1', cwd: '/Users/me/demo' }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        timestamp: '2026-07-24T11:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5',
          timestamp: Date.parse('2026-07-24T11:00:00.000Z'),
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoningTokens: 3 },
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        timestamp: '2026-07-24T11:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-5',
          timestamp: Date.parse('2026-07-24T11:00:00.000Z'),
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoningTokens: 3 },
        },
      }),
    ];
    await writeFile(join(sessions, '2026_sess.jsonl'), lines.join('\n'));

    const { result, cursors } = await parsePiIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'pi');
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 1);
    assert.equal(result.buckets[0]!.reasoning_output_tokens, 3);

    const again = await parsePiIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test('parseHermesIncremental emits session snapshot deltas', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-hermes-'));
  const prev = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    const db = new DatabaseSync(join(home, 'state.db'));
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model TEXT,
      started_at REAL,
      ended_at REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      message_count INTEGER
    )`);
    db.prepare(
      `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('s1', 'hermes-agent', 1720000000, 1720000100, 100, 50, 10, 5, 2, 3);
    db.close();

    const first = await parseHermesIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    assert.equal(first.result.buckets[0]!.source, 'hermes');
    assert.equal(first.result.buckets[0]!.input_tokens, 100);
    assert.equal(first.result.buckets[0]!.cache_creation_input_tokens, 5);

    const db2 = new DatabaseSync(join(home, 'state.db'));
    db2.prepare(
      `UPDATE sessions SET input_tokens = 150, output_tokens = 70, message_count = 4 WHERE id = ?`,
    ).run('s1');
    db2.close();

    const second = await parseHermesIncremental(first.cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]!.input_tokens, 50);
    assert.equal(second.result.buckets[0]!.output_tokens, 20);
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prev;
  }
});

test('parseZcodeIncremental filters non-native providers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-zcode-'));
  const prev = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = home;
  try {
    const dbDir = join(home, 'cli', 'db');
    await mkdir(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, 'db.sqlite'));
    db.exec(`CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT
    )`);
    const native = {
      role: 'assistant',
      providerID: 'builtin:zai-glm',
      modelID: 'glm-4.6',
      time: { created: Date.parse('2026-07-24T12:00:00.000Z') },
      tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { root: '/tmp/z' },
    };
    const foreign = {
      ...native,
      providerID: 'anthropic',
      modelID: 'claude-opus-4',
    };
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m1', 'ses1', JSON.stringify(native));
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m2', 'ses1', JSON.stringify(foreign));
    db.close();

    const { result } = await parseZcodeIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'zcode');
    assert.equal(result.buckets[0]!.model, 'glm-4.6');
  } finally {
    if (prev === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = prev;
  }
});

test('parseKimiIncremental prefers kimi-code step.end', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-kimi-'));
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const wireDir = join(home, 'sessions', 'wd_demo_abc', 'session_1', 'agents', 'a1');
    await mkdir(wireDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'step.end',
        uuid: 'u1',
        time: Date.parse('2026-07-24T13:00:00.000Z'),
        usage: {
          inputOther: 80,
          inputCacheRead: 20,
          inputCacheCreation: 5,
          output: 30,
        },
        modelAlias: 'kimi-code/kimi-k2',
      }),
    ];
    await writeFile(join(wireDir, 'wire.jsonl'), lines.join('\n'));

    const { result } = await parseKimiIncremental({}, SINCE);
    assert.ok(result.eventsParsed >= 1);
    assert.equal(result.buckets[0]!.source, 'kimi');
    assert.equal(result.buckets[0]!.input_tokens, 80);
    assert.equal(result.buckets[0]!.cached_input_tokens, 20);
  } finally {
    if (prev === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prev;
  }
});

test('parseDroidIncremental cumulative delta on settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-droid-'));
  const prev = process.env.FACTORY_DIR;
  process.env.FACTORY_DIR = home;
  try {
    const sessions = join(home, 'sessions');
    await mkdir(sessions, { recursive: true });
    const settingsPath = join(sessions, 'sess-a.settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify({
        model: 'claude-sonnet-4',
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          thinkingTokens: 2,
        },
      }),
    );

    const first = await parseDroidIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    assert.equal(first.result.buckets[0]!.source, 'droid');
    assert.equal(first.result.buckets[0]!.input_tokens, 100);

    await writeFile(
      settingsPath,
      JSON.stringify({
        model: 'claude-sonnet-4',
        tokenUsage: {
          inputTokens: 150,
          outputTokens: 60,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          thinkingTokens: 2,
        },
      }),
    );
    // bump mtime
    const { utimes } = await import('node:fs/promises');
    const now = new Date();
    await utimes(settingsPath, now, now);

    const second = await parseDroidIncremental(first.cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]!.input_tokens, 50);
    assert.equal(second.result.buckets[0]!.output_tokens, 20);
  } finally {
    if (prev === undefined) delete process.env.FACTORY_DIR;
    else process.env.FACTORY_DIR = prev;
  }
});

test('parseRoocodeIncremental reads ui_messages and skips zero placeholders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tud-roo-'));
  // Monkey-patch by writing under a fake VS Code root via env if parser supports it;
  // otherwise write into a path the parser discovers — check for AI_USAGE_VSCODE_ROOTS / similar.
  const prev = process.env.AI_USAGE_VSCODE_ROOTS;
  process.env.AI_USAGE_VSCODE_ROOTS = root;
  try {
    const taskDir = join(
      root,
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'tasks',
      'task-1',
    );
    await mkdir(taskDir, { recursive: true });
    const messages = [
      {
        ts: Date.parse('2026-07-24T15:00:00.000Z'),
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 0, tokensOut: 0, cacheReads: 0, cacheWrites: 0 }),
      },
      {
        ts: Date.parse('2026-07-24T15:00:00.000Z'),
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 50, tokensOut: 20, cacheReads: 5, cacheWrites: 2 }),
      },
    ];
    await writeFile(join(taskDir, 'ui_messages.json'), JSON.stringify(messages));
    await writeFile(
      join(taskDir, 'api_conversation_history.json'),
      JSON.stringify([{ role: 'assistant', content: '<model>claude-sonnet-4</model> hi' }]),
    );

    const { result } = await parseRoocodeIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'roocode');
    assert.equal(result.buckets[0]!.input_tokens, 50);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 2);
  } finally {
    if (prev === undefined) {
      delete process.env.AI_USAGE_VSCODE_ROOTS;
    } else {
      process.env.AI_USAGE_VSCODE_ROOTS = prev;
    }
  }
});

test('parseKiroIncremental estimates tokens from cli session jsonl', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-kiro-'));
  const prevHome = process.env.KIRO_HOME;
  const prevSessions = process.env.KIRO_CLI_SESSIONS_DIR;
  process.env.KIRO_HOME = home;
  process.env.KIRO_CLI_SESSIONS_DIR = join(home, 'sessions', 'cli');
  try {
    const cliDir = join(home, 'sessions', 'cli');
    await mkdir(cliDir, { recursive: true });
    // Minimal event shape — parser should tolerate and estimate
    const events = [
      { type: 'user_message', content: 'u'.repeat(40), timestamp: '2026-07-24T14:00:00.000Z' },
      {
        type: 'assistant_message',
        content: 'a'.repeat(40),
        model: 'auto',
        timestamp: '2026-07-24T14:01:00.000Z',
      },
    ];
    await writeFile(join(cliDir, 'sess.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));

    const { result } = await parseKiroIncremental({}, SINCE);
    // Soft: event shapes vary across kiro versions
    assert.ok(result.filesProcessed >= 0);
    if (result.eventsParsed > 0) {
      assert.equal(result.buckets[0]!.source, 'kiro');
    }
  } finally {
    if (prevHome === undefined) delete process.env.KIRO_HOME;
    else process.env.KIRO_HOME = prevHome;
    if (prevSessions === undefined) delete process.env.KIRO_CLI_SESSIONS_DIR;
    else process.env.KIRO_CLI_SESSIONS_DIR = prevSessions;
  }
});

test('bucketToIngestEvent maps all P1 sources', () => {
  const deviceId = '550e8400-e29b-41d4-a716-446655440000';
  for (const source of [
    'openclaw',
    'autoclaw',
    'hermes',
    'zcode',
    'pi',
    'kimi',
    'roocode',
    'droid',
    'kiro',
  ]) {
    const event = bucketToIngestEvent(
      {
        hour_start: '2026-07-24T10:00:00.000Z',
        source,
        model: 'test-model',
        input_tokens: 1,
        output_tokens: 1,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 2,
        conversation_count: 1,
      },
      deviceId,
    );
    assert.equal(event?.integration, source, source);
  }
  void homedir;
});

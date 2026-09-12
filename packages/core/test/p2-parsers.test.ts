import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { parseClineIncremental } from '../src/parsers/cline.js';
import { parseAmpIncremental } from '../src/parsers/amp.js';
import { parseQwenIncremental } from '../src/parsers/qwen.js';
import { parseCodebuddyIncremental } from '../src/parsers/codebuddy.js';
import {
  parseWorkbuddyIncremental,
  resolveWorkbuddyHome,
  workbuddyHomeCandidates,
} from '../src/parsers/workbuddy.js';
import { parseGrokBuildIncremental } from '../src/parsers/grok.js';
import { parseMimoIncremental } from '../src/parsers/mimo.js';
import { parseEveryCodeIncremental } from '../src/parsers/every-code.js';
import { bucketToIngestEvent } from '../src/upload/events.js';
import type { CursorsFile } from '../src/types.js';

const SINCE = '2020-01-01T00:00:00.000Z';
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';

test('parseClineIncremental reads api_req_started token columns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tud-cline-'));
  const extDir = join(root, 'cline-ext');
  const prev = process.env.AI_USAGE_CLINE_ROOTS;
  process.env.AI_USAGE_CLINE_ROOTS = extDir;
  try {
    await mkdir(join(extDir, 'state'), { recursive: true });
    await mkdir(join(extDir, 'tasks', 'task-1'), { recursive: true });
    await writeFile(
      join(extDir, 'state', 'taskHistory.json'),
      JSON.stringify([
        {
          id: 'task-1',
          modelId: 'claude-sonnet-4',
          cwdOnTaskInitialization: '/Users/me/demo',
        },
      ]),
    );
    const messages = [
      {
        type: 'say',
        say: 'api_req_started',
        ts: Date.parse('2026-07-24T16:00:00.000Z'),
        text: JSON.stringify({
          tokensIn: 80,
          tokensOut: 30,
          cacheReads: 10,
          cacheWrites: 5,
          model: 'claude-sonnet-4',
        }),
      },
    ];
    await writeFile(join(extDir, 'tasks', 'task-1', 'ui_messages.json'), JSON.stringify(messages));

    const { result } = await parseClineIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'cline');
    assert.equal(result.buckets[0]!.input_tokens, 80);
    assert.equal(result.buckets[0]!.cached_input_tokens, 10);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 5);
    assert.equal(result.buckets[0]!.output_tokens, 30);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_CLINE_ROOTS;
    else process.env.AI_USAGE_CLINE_ROOTS = prev;
  }
});

test('parseAmpIncremental reads usageLedger events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-amp-'));
  const prev = process.env.AMP_DATA_DIR;
  process.env.AMP_DATA_DIR = dir;
  try {
    await writeFile(
      join(dir, 'T-thread-1.json'),
      JSON.stringify({
        id: 'thread-1',
        messages: [],
        usageLedger: {
          events: [
            {
              timestamp: '2026-07-24T10:00:00.000Z',
              tokens: { input: 100, output: 50 },
              model: 'claude-sonnet-4',
            },
          ],
        },
      }),
    );

    const { result } = await parseAmpIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'amp');
    assert.equal(result.buckets[0]!.input_tokens, 100);
    assert.equal(result.buckets[0]!.output_tokens, 50);
  } finally {
    if (prev === undefined) delete process.env.AMP_DATA_DIR;
    else process.env.AMP_DATA_DIR = prev;
  }
});

test('parseQwenIncremental subtracts cached and thoughts from usageMetadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-qwen-'));
  const prev = process.env.QWEN_TMP_DIR;
  process.env.QWEN_TMP_DIR = dir;
  try {
    const chatsDir = join(dir, 'proj1', 'chats');
    await mkdir(chatsDir, { recursive: true });
    await writeFile(
      join(chatsDir, 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        uuid: 'u1',
        timestamp: '2026-07-24T10:00:00.000Z',
        model: 'qwen-max',
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 60,
          cachedContentTokenCount: 20,
          thoughtsTokenCount: 10,
        },
      }) + '\n',
    );

    const { result } = await parseQwenIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'qwen');
    assert.equal(result.buckets[0]!.input_tokens, 100);
    assert.equal(result.buckets[0]!.cached_input_tokens, 20);
    assert.equal(result.buckets[0]!.output_tokens, 50);
    assert.equal(result.buckets[0]!.reasoning_output_tokens, 10);
  } finally {
    if (prev === undefined) delete process.env.QWEN_TMP_DIR;
    else process.env.QWEN_TMP_DIR = prev;
  }
});

test('parseWorkbuddyIncremental subtracts cacheRead and cacheCreate from prompt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-wb-'));
  const prev = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  try {
    const projects = join(home, 'projects');
    await mkdir(projects, { recursive: true });
    const filePath = join(projects, 'sess-a.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({
        sessionId: 'sess-a',
        id: 'm1',
        timestamp: Date.parse('2026-07-24T11:00:00.000Z'),
        providerData: {
          model: 'wb-model',
          rawUsage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            cache_read_input_tokens: 15,
            cache_creation_input_tokens: 5,
          },
        },
      }) + '\n',
    );

    const { result } = await parseWorkbuddyIncremental({}, SINCE, {
      projectFiles: [filePath],
      defaultModel: 'auto',
    });
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'workbuddy');
    assert.equal(result.buckets[0]!.input_tokens, 80);
    assert.equal(result.buckets[0]!.cached_input_tokens, 15);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 5);
    assert.equal(result.buckets[0]!.output_tokens, 40);
  } finally {
    if (prev === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = prev;
  }
});

const WORKBUDDY_ENV_KEYS = ['HOME', 'USERPROFILE', 'WORKBUDDY_HOME'] as const;

type WorkbuddyEnvSnapshot = Record<(typeof WORKBUDDY_ENV_KEYS)[number], string | undefined>;

function snapshotWorkbuddyEnv(): WorkbuddyEnvSnapshot {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    WORKBUDDY_HOME: process.env.WORKBUDDY_HOME,
  };
}

function restoreWorkbuddyEnv(snapshot: WorkbuddyEnvSnapshot): void {
  for (const key of WORKBUDDY_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

/** Pin HOME to a temp tree so home discovery cannot see the developer's real homes. */
function pinWorkbuddyHome(tempHome: string): void {
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  delete process.env.WORKBUDDY_HOME;
}

function workbuddyUsageLine(opts: {
  sessionId: string;
  messageId: string;
  model?: string;
  timestamp?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    sessionId: opts.sessionId,
    id: opts.messageId,
    timestamp: Date.parse(opts.timestamp ?? '2026-07-24T11:00:00.000Z'),
    providerData: {
      model: opts.model ?? 'wb-model',
      rawUsage: {
        prompt_tokens: opts.promptTokens ?? 100,
        completion_tokens: opts.completionTokens ?? 40,
        cache_read_input_tokens: opts.cacheRead ?? 20,
      },
    },
  });
}

test('workbuddyHomeCandidates covers both editions and honours the override', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-wb-home-'));
  const snapshot = snapshotWorkbuddyEnv();
  try {
    pinWorkbuddyHome(tempHome);
    assert.deepEqual(workbuddyHomeCandidates(), [
      join(tempHome, '.workbuddy'),
      join(tempHome, '.workbuddy-ai'),
    ]);

    process.env.WORKBUDDY_HOME = '~/custom-workbuddy';
    assert.deepEqual(workbuddyHomeCandidates(), [join(tempHome, 'custom-workbuddy')]);
    assert.equal(resolveWorkbuddyHome(), join(tempHome, 'custom-workbuddy'));
  } finally {
    restoreWorkbuddyEnv(snapshot);
  }
});

test('parseWorkbuddyIncremental reads the international ~/.workbuddy-ai home', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-wb-intl-'));
  const snapshot = snapshotWorkbuddyEnv();
  try {
    pinWorkbuddyHome(tempHome);
    const intlProjects = join(tempHome, '.workbuddy-ai', 'projects');
    await mkdir(intlProjects, { recursive: true });
    await writeFile(
      join(intlProjects, 'sess-intl.jsonl'),
      workbuddyUsageLine({
        sessionId: 'sess-intl',
        messageId: 'm-intl',
        model: 'wb-intl-model',
      }) + '\n',
    );

    const { result } = await parseWorkbuddyIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'workbuddy');
    assert.equal(result.buckets[0]!.model, 'wb-intl-model');
    assert.equal(result.buckets[0]!.input_tokens, 80);
    assert.equal(result.buckets[0]!.cached_input_tokens, 20);
  } finally {
    restoreWorkbuddyEnv(snapshot);
  }
});

test('parseWorkbuddyIncremental aggregates both homes without double counting', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-wb-both-'));
  const snapshot = snapshotWorkbuddyEnv();
  try {
    pinWorkbuddyHome(tempHome);
    const domProjects = join(tempHome, '.workbuddy', 'projects');
    const intlProjects = join(tempHome, '.workbuddy-ai', 'projects');
    await mkdir(domProjects, { recursive: true });
    await mkdir(intlProjects, { recursive: true });

    const shared = workbuddyUsageLine({ sessionId: 'sess-shared', messageId: 'm-shared' });
    await writeFile(join(domProjects, 'sess-shared.jsonl'), `${shared}\n`);
    await writeFile(join(intlProjects, 'sess-shared.jsonl'), `${shared}\n`);
    await writeFile(
      join(intlProjects, 'sess-intl-only.jsonl'),
      workbuddyUsageLine({ sessionId: 'sess-intl-only', messageId: 'm-intl-only' }) + '\n',
    );

    const { result } = await parseWorkbuddyIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 2);
    const totalInput = result.buckets.reduce((sum, b) => sum + b.input_tokens, 0);
    assert.equal(totalInput, 160);
  } finally {
    restoreWorkbuddyEnv(snapshot);
  }
});

test('parseWorkbuddyIncremental keeps WORKBUDDY_HOME a full override', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-wb-override-'));
  const customHome = await mkdtemp(join(tmpdir(), 'tud-wb-custom-'));
  const snapshot = snapshotWorkbuddyEnv();
  try {
    pinWorkbuddyHome(tempHome);
    const intlProjects = join(tempHome, '.workbuddy-ai', 'projects');
    await mkdir(intlProjects, { recursive: true });
    await writeFile(
      join(intlProjects, 'sess-intl.jsonl'),
      workbuddyUsageLine({ sessionId: 'sess-intl', messageId: 'm-intl' }) + '\n',
    );

    const customProjects = join(customHome, 'projects');
    await mkdir(customProjects, { recursive: true });
    await writeFile(
      join(customProjects, 'sess-custom.jsonl'),
      workbuddyUsageLine({
        sessionId: 'sess-custom',
        messageId: 'm-custom',
        model: 'wb-custom-model',
      }) + '\n',
    );

    process.env.WORKBUDDY_HOME = customHome;
    const { result } = await parseWorkbuddyIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.model, 'wb-custom-model');
    assert.equal(result.buckets[0]!.input_tokens, 80);
  } finally {
    restoreWorkbuddyEnv(snapshot);
  }
});

test('parseWorkbuddyIncremental falls back to session_usage in the intl DB', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-wb-intl-db-'));
  const snapshot = snapshotWorkbuddyEnv();
  try {
    pinWorkbuddyHome(tempHome);
    const intlHome = join(tempHome, '.workbuddy-ai');
    await mkdir(intlHome, { recursive: true });
    const dbPath = join(intlHome, 'workbuddy.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, cwd TEXT)');
    db.exec(`CREATE TABLE session_usage (
      session_id TEXT PRIMARY KEY,
      used INTEGER,
      updated_at INTEGER
    )`);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('sess-db', 'wb-db-model', '/tmp/app');
    db.prepare('INSERT INTO session_usage VALUES (?, ?, ?)').run(
      'sess-db',
      120,
      Date.parse('2026-07-24T11:00:00.000Z'),
    );
    db.close();

    const { result } = await parseWorkbuddyIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'workbuddy');
    assert.equal(result.buckets[0]!.model, 'wb-db-model');
    assert.equal(result.buckets[0]!.input_tokens, 120);
  } finally {
    restoreWorkbuddyEnv(snapshot);
  }
});

async function createWorkbuddyUsageDb(
  homeDir: string,
  sessionId: string,
  used: number,
  updatedAt: number,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const db = new DatabaseSync(join(homeDir, 'workbuddy.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, cwd TEXT)');
  db.exec(`CREATE TABLE session_usage (
    session_id TEXT PRIMARY KEY,
    used INTEGER,
    updated_at INTEGER
  )`);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sessionId, 'wb-db-model', '/tmp/app');
  db.prepare('INSERT INTO session_usage VALUES (?, ?, ?)').run(sessionId, used, updatedAt);
  db.close();
}

test('parseWorkbuddyIncremental counts a sqlite session mirrored in both homes once', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-wb-db-mirror-'));
  const snapshot = snapshotWorkbuddyEnv();
  try {
    pinWorkbuddyHome(tempHome);
    const updatedAt = Date.parse('2026-07-24T11:00:00.000Z');
    // Same session id recorded by both editions with the same counter.
    await createWorkbuddyUsageDb(join(tempHome, '.workbuddy'), 'sess-mirror', 120, updatedAt);
    await createWorkbuddyUsageDb(join(tempHome, '.workbuddy-ai'), 'sess-mirror', 120, updatedAt);

    const { result, cursors } = await parseWorkbuddyIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    const totalInput = result.buckets.reduce((sum, b) => sum + b.input_tokens, 0);
    assert.equal(totalInput, 120);
    const ext = cursors as { workbuddy?: { sqliteSessions?: Record<string, { used: number }> } };
    assert.equal(ext.workbuddy?.sqliteSessions?.['sess-mirror']?.used, 120);
  } finally {
    restoreWorkbuddyEnv(snapshot);
  }
});

test('parseWorkbuddyIncremental keeps the sqlite cursor stable when a mirrored session lags', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-wb-db-lag-'));
  const snapshot = snapshotWorkbuddyEnv();
  try {
    pinWorkbuddyHome(tempHome);
    const updatedAt = Date.parse('2026-07-24T11:00:00.000Z');
    // Same session id, but the intl counter lags behind the CN one.
    await createWorkbuddyUsageDb(join(tempHome, '.workbuddy'), 'sess-lag', 120, updatedAt);
    await createWorkbuddyUsageDb(join(tempHome, '.workbuddy-ai'), 'sess-lag', 80, updatedAt);

    const first = await parseWorkbuddyIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    const firstInput = first.result.buckets.reduce((sum, b) => sum + b.input_tokens, 0);
    assert.equal(firstInput, 120);

    // A lagging mirror must not flip the cursor: later runs emit nothing.
    const second = await parseWorkbuddyIncremental(first.cursors, SINCE);
    assert.equal(second.result.eventsParsed, 0);
    const secondInput = second.result.buckets.reduce((sum, b) => sum + b.input_tokens, 0);
    assert.equal(secondInput, 0);
  } finally {
    restoreWorkbuddyEnv(snapshot);
  }
});

test('parseCodebuddyIncremental subtracts cached tokens from prompt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-cb-'));
  const prev = process.env.CODEBUDDY_HOME;
  process.env.CODEBUDDY_HOME = home;
  try {
    const projects = join(home, 'projects');
    await mkdir(projects, { recursive: true });
    const filePath = join(projects, 'sess-b.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        uuid: 'm1',
        timestamp: Date.parse('2026-07-24T12:00:00.000Z'),
        providerData: {
          model: 'cb-model',
          rawUsage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 25 },
            cache_creation_input_tokens: 3,
          },
        },
      }) + '\n',
    );

    const { result } = await parseCodebuddyIncremental({}, SINCE, {
      projectFiles: [filePath],
      defaultModel: 'codebuddy-unknown',
    });
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'codebuddy');
    assert.equal(result.buckets[0]!.input_tokens, 75);
    assert.equal(result.buckets[0]!.cached_input_tokens, 25);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 3);
  } finally {
    if (prev === undefined) delete process.env.CODEBUDDY_HOME;
    else process.env.CODEBUDDY_HOME = prev;
  }
});

test('parseMimoIncremental keeps mimo rows and drops anthropic mirror', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-mimo-'));
  const dbPath = join(dir, 'mimocode.db');
  const prev = process.env.MIMO_DB_PATH;
  process.env.MIMO_DB_PATH = dbPath;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT
    )`);
    const native = {
      role: 'assistant',
      providerID: 'mimo',
      modelID: 'mimo-v2',
      time: { created: Date.parse('2026-07-24T13:00:00.000Z') },
      tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { root: '/tmp/mimo' },
    };
    const foreign = {
      ...native,
      providerID: 'anthropic',
      modelID: 'claude-opus-4',
    };
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m1', 'ses1', JSON.stringify(native));
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m2', 'ses1', JSON.stringify(foreign));
    db.close();

    const { result } = await parseMimoIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'mimo');
    assert.equal(result.buckets[0]!.model, 'mimo-v2');
    assert.equal(result.buckets[0]!.input_tokens, 30);
  } finally {
    if (prev === undefined) delete process.env.MIMO_DB_PATH;
    else process.env.MIMO_DB_PATH = prev;
  }
});

test('parseEveryCodeIncremental emits cumulative token_count deltas', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-ec-'));
  const prev = process.env.AI_USAGE_EVERY_CODE_HOME;
  process.env.AI_USAGE_EVERY_CODE_HOME = home;
  try {
    const sessions = join(home, 'sessions');
    await mkdir(sessions, { recursive: true });
    const rolloutPath = join(sessions, '2026_sess.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'sess-ec-1', cwd: '/tmp/every-code' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-24T14:00:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5',
            total_token_usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-07-24T14:30:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: 'gpt-5',
            total_token_usage: { input_tokens: 150, output_tokens: 80 },
          },
        },
      }),
    ];
    await writeFile(rolloutPath, lines.join('\n') + '\n');

    const { result } = await parseEveryCodeIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 2);
    assert.equal(result.buckets[0]!.source, 'every-code');
    const inputTotal = result.buckets.reduce((sum, b) => sum + b.input_tokens, 0);
    const outputTotal = result.buckets.reduce((sum, b) => sum + b.output_tokens, 0);
    assert.equal(inputTotal, 150);
    assert.equal(outputTotal, 80);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_EVERY_CODE_HOME;
    else process.env.AI_USAGE_EVERY_CODE_HOME = prev;
  }
});

test('parseEveryCodeIncremental persists lastModel across tail scans without info.model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-ec-'));
  const prev = process.env.AI_USAGE_EVERY_CODE_HOME;
  process.env.AI_USAGE_EVERY_CODE_HOME = home;
  try {
    const sessions = join(home, 'sessions');
    await mkdir(sessions, { recursive: true });
    const rolloutPath = join(sessions, '2026_last_model.jsonl');
    const prefix = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'sess-ec-model', cwd: '/tmp/every-code' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'deepseek-v4-flash' },
      }),
    ].join('\n');
    await writeFile(rolloutPath, `${prefix}\n`);

    const cursors: CursorsFile = {};
    const first = await parseEveryCodeIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 0);
    assert.equal(cursors.everyCode!.files[rolloutPath]!.lastModel, 'deepseek-v4-flash');

    const tokenLine = JSON.stringify({
      timestamp: '2026-07-24T14:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } },
      },
    });
    await writeFile(rolloutPath, `${prefix}\n${tokenLine}\n`);
    const second = await parseEveryCodeIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]!.model, 'deepseek-v4-flash');
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_EVERY_CODE_HOME;
    else process.env.AI_USAGE_EVERY_CODE_HOME = prev;
  }
});

test('parseGrokBuildIncremental diffs updates.jsonl high-water marks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-grok-'));
  const prev = process.env.AI_USAGE_GROK_HOME;
  process.env.AI_USAGE_GROK_HOME = home;
  try {
    const encodedCwd = encodeURIComponent('/Users/me/apps/demo-app');
    const sessionDir = join(home, 'sessions', encodedCwd, 'sess-grok-1');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'signals.json'), JSON.stringify({ primaryModelId: 'grok-3' }));
    const updatesPath = join(sessionDir, 'updates.jsonl');
    const line1 = JSON.stringify({
      params: {
        _meta: {
          totalTokens: 100,
          eventId: 'e1',
          agentTimestampMs: Date.parse('2026-07-24T15:00:00.000Z'),
        },
      },
    });
    const line2 = JSON.stringify({
      params: {
        _meta: {
          totalTokens: 250,
          eventId: 'e2',
          agentTimestampMs: Date.parse('2026-07-24T15:30:00.000Z'),
        },
      },
    });
    await writeFile(updatesPath, `${line1}\n${line2}\n`);

    const first = await parseGrokBuildIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 2);
    assert.equal(first.result.buckets[0]!.source, 'grok');
    assert.equal(first.result.buckets[0]!.project, 'demo-app');
    const firstTotal = first.result.buckets.reduce((sum, b) => sum + b.total_tokens, 0);
    assert.equal(firstTotal, 250);

    const line3 = JSON.stringify({
      params: {
        _meta: {
          totalTokens: 400,
          eventId: 'e3',
          agentTimestampMs: Date.parse('2026-07-24T16:00:00.000Z'),
        },
      },
    });
    await appendFile(updatesPath, `${line3}\n`);

    const second = await parseGrokBuildIncremental(first.cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]!.total_tokens, 150);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_GROK_HOME;
    else process.env.AI_USAGE_GROK_HOME = prev;
  }
});

test('bucketToIngestEvent maps P2 sources and collectors', () => {
  const cases: Array<{
    source: string;
    collector: string;
    integration: string;
    expectedCollector: string;
  }> = [
    { source: 'cline', collector: 'cline', integration: 'cline', expectedCollector: 'cline' },
    { source: 'qwen', collector: 'qwen-code', integration: 'qwen-code', expectedCollector: 'qwen-code' },
    { source: 'grok', collector: 'grok-build', integration: 'grok', expectedCollector: 'grok-build' },
    { source: 'mimo', collector: 'mimocode', integration: 'mimo', expectedCollector: 'mimocode' },
    { source: 'every-code', collector: 'every-code', integration: 'every-code', expectedCollector: 'every-code' },
  ];

  for (const c of cases) {
    const event = bucketToIngestEvent(
      {
        hour_start: '2026-07-24T10:00:00.000Z',
        source: c.source,
        model: 'test-model',
        collector: c.collector,
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 15,
        conversation_count: 1,
      },
      DEVICE_ID,
    );
    assert.equal(event?.integration, c.integration, c.source);
    assert.equal(event?.collector, c.expectedCollector, c.source);
  }
});

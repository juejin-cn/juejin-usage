import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { parseOmpIncremental } from '../src/parsers/omp.js';
import { parseKiloCliIncremental } from '../src/parsers/kilo-cli.js';
import { parseKilocodeIncremental } from '../src/parsers/kilocode.js';
import { parseGooseIncremental } from '../src/parsers/goose.js';
import { parseZedIncremental } from '../src/parsers/zed.js';
import { splitRootsEnv } from '../src/parsers/shared.js';
import { bucketToIngestEvent } from '../src/upload/events.js';

const SINCE = '2020-01-01T00:00:00.000Z';
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';

test('parseOmpIncremental uses entry.id dedup and cacheWrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-omp-'));
  const prev = process.env.AI_USAGE_OMP_AGENT_DIR;
  process.env.AI_USAGE_OMP_AGENT_DIR = dir;
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

    const { result, cursors } = await parseOmpIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'omp');
    assert.equal(result.buckets[0]!.collector, 'omp');
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 1);
    assert.equal(result.buckets[0]!.reasoning_output_tokens, 3);

    const again = await parseOmpIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_OMP_AGENT_DIR;
    else process.env.AI_USAGE_OMP_AGENT_DIR = prev;
  }
});

test('parseKiloCliIncremental reads sqlite message tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-kilo-cli-'));
  const dbPath = join(dir, 'kilo.db');
  const prev = process.env.KILO_CLI_DB;
  process.env.KILO_CLI_DB = dbPath;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT
    )`);
    const payload = {
      role: 'assistant',
      modelID: 'kilo-model',
      time: { created: Date.parse('2026-07-24T13:00:00.000Z'), completed: Date.parse('2026-07-24T13:00:00.000Z') },
      tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 5, write: 2 } },
      path: { root: '/tmp/kilo' },
    };
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m1', 'ses1', JSON.stringify(payload));
    db.close();

    const { result } = await parseKiloCliIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'kilo-cli');
    assert.equal(result.buckets[0]!.collector, 'kilo-cli');
    assert.equal(result.buckets[0]!.model, 'kilo-model');
    assert.equal(result.buckets[0]!.input_tokens, 30);
    assert.equal(result.buckets[0]!.cached_input_tokens, 5);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 2);
  } finally {
    if (prev === undefined) delete process.env.KILO_CLI_DB;
    else process.env.KILO_CLI_DB = prev;
  }
});

test('parseKilocodeIncremental reads ui_messages via AI_USAGE_KILOCODE_ROOTS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tud-kilocode-'));
  const prev = process.env.AI_USAGE_KILOCODE_ROOTS;
  process.env.AI_USAGE_KILOCODE_ROOTS = root;
  try {
    const taskDir = join(
      root,
      'User',
      'globalStorage',
      'kilocode.kilo-code',
      'tasks',
      'task-kc-1',
    );
    await mkdir(taskDir, { recursive: true });
    const messages = [
      {
        say: 'api_req_started',
        ts: Date.parse('2026-07-24T16:00:00.000Z'),
        text: JSON.stringify({
          tokensIn: 80,
          tokensOut: 30,
          cacheReads: 10,
          cacheWrites: 5,
          inferenceProvider: 'Anthropic Claude',
        }),
      },
    ];
    await writeFile(join(taskDir, 'ui_messages.json'), JSON.stringify(messages));

    const { result } = await parseKilocodeIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'kilocode');
    assert.equal(result.buckets[0]!.collector, 'kilo-code');
    assert.equal(result.buckets[0]!.input_tokens, 80);
    assert.equal(result.buckets[0]!.cached_input_tokens, 10);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 5);
    assert.equal(result.buckets[0]!.output_tokens, 30);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_KILOCODE_ROOTS;
    else process.env.AI_USAGE_KILOCODE_ROOTS = prev;
  }
});

test('parseGooseIncremental diffs accumulated_* session totals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-goose-'));
  const dbPath = join(dir, 'sessions.db');
  const prev = process.env.AI_USAGE_GOOSE_DB;
  process.env.AI_USAGE_GOOSE_DB = dbPath;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model_config_json TEXT,
      created_at TEXT,
      accumulated_total_tokens INTEGER,
      accumulated_input_tokens INTEGER,
      accumulated_output_tokens INTEGER
    )`);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      'sess-goose-1',
      JSON.stringify({ model_name: 'gpt-4' }),
      '2026-07-24T14:00:00',
      165,
      100,
      50,
    );
    db.close();

    const { result } = await parseGooseIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'goose');
    assert.equal(result.buckets[0]!.collector, 'goose');
    assert.equal(result.buckets[0]!.input_tokens, 100);
    assert.equal(result.buckets[0]!.output_tokens, 50);
    assert.equal(result.buckets[0]!.reasoning_output_tokens, 15);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_GOOSE_DB;
    else process.env.AI_USAGE_GOOSE_DB = prev;
  }
});

test('parseZedIncremental reads plaintext json thread blobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-zed-'));
  const dbPath = join(dir, 'threads.db');
  const prev = process.env.AI_USAGE_ZED_DB;
  process.env.AI_USAGE_ZED_DB = dbPath;
  try {
    const thread = {
      model: { model: 'claude-sonnet-4' },
      cumulative_token_usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      updated_at: '2026-07-24T15:00:00.000Z',
    };
    const blob = Buffer.from(JSON.stringify(thread), 'utf8');

    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      updated_at TEXT,
      created_at TEXT,
      data_type TEXT,
      data BLOB
    )`);
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(
      'thread-1',
      '2026-07-24T15:00:00.000Z',
      '2026-07-24T15:00:00.000Z',
      'json',
      blob,
    );
    db.close();

    const { result } = await parseZedIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'zed');
    assert.equal(result.buckets[0]!.collector, 'zed');
    assert.equal(result.buckets[0]!.input_tokens, 100);
    assert.equal(result.buckets[0]!.output_tokens, 50);
    assert.equal(result.buckets[0]!.cached_input_tokens, 10);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 5);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_ZED_DB;
    else process.env.AI_USAGE_ZED_DB = prev;
  }
});

test('bucketToIngestEvent maps long-tail sources and collectors', () => {
  const cases: Array<{
    source: string;
    collector: string;
    integration: string;
    expectedCollector: string;
  }> = [
    { source: 'omp', collector: 'omp', integration: 'omp', expectedCollector: 'omp' },
    {
      source: 'kilo-cli',
      collector: 'kilo-cli',
      integration: 'kilo-cli',
      expectedCollector: 'kilo-cli',
    },
    {
      source: 'kilocode',
      collector: 'kilo-code',
      integration: 'kilocode',
      expectedCollector: 'kilo-code',
    },
    { source: 'goose', collector: 'goose', integration: 'goose', expectedCollector: 'goose' },
    { source: 'zed', collector: 'zed', integration: 'zed', expectedCollector: 'zed' },
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

test('splitRootsEnv keeps an absolute path of the running platform intact', () => {
  // On Windows an absolute path starts `C:\\`. Treating `:` as a separator
  // there splits every entry at the drive letter, so the AI_USAGE_*_ROOTS
  // overrides resolved to two nonexistent fragments and the parsers reported
  // nothing at all.
  const root = join(tmpdir(), 'tud-roots-fixture');
  assert.deepEqual(splitRootsEnv(root), [root]);
});

test('splitRootsEnv splits on the portable separators and expands ~', () => {
  const home = homedir();
  assert.deepEqual(splitRootsEnv('/a;/b,/c'), ['/a', '/b', '/c']);
  assert.deepEqual(splitRootsEnv(' /a ,, /b '), ['/a', '/b']);
  assert.deepEqual(splitRootsEnv('~'), [home]);
  assert.deepEqual(splitRootsEnv('~/x'), [join(home, 'x')]);
});

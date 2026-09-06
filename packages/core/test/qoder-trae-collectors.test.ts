import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  CLAUDE_COLLECTOR_CLI,
  CLAUDE_COLLECTOR_DESKTOP,
  parseClaudeIncremental,
} from '../src/parsers/claude.js';
import { parseQoderIncremental } from '../src/parsers/qoder.js';
import { parseTraeIncremental } from '../src/parsers/trae.js';
import {
  decryptTraeDatabase,
  saveTraeSqlcipherKeyFile,
  verifyTraeSqlcipherKey,
} from '../src/parsers/trae-decrypt.js';
import { createCipheriv, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { bucketToIngestEvent } from '../src/upload/events.js';
import { aggregateForIngest } from '../src/aggregate.js';
import { bucketKey, ingestBucketKey } from '../src/queue/keys.js';
import type { QueueBucket } from '../src/types.js';

const PAGE_SIZE = 4096;
const RESERVE_SIZE = 80;
const SALT_SIZE = 16;

function makeRow(
  partial: Partial<QueueBucket> & Pick<QueueBucket, 'source' | 'model'>,
): QueueBucket {
  return {
    hour_start: '2026-07-09T10:00:00.000Z',
    project: 'unknown',
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 150,
    conversation_count: 1,
    ...partial,
  };
}

test('bucketKey and ingestBucketKey include collector', () => {
  const a = makeRow({ source: 'qoder', model: 'auto', collector: 'qoder-ide' });
  const b = makeRow({ source: 'qoder', model: 'auto', collector: 'qoder-cn-ide' });
  assert.notEqual(bucketKey(a), bucketKey(b));
  assert.notEqual(ingestBucketKey(a), ingestBucketKey(b));
});

test('aggregateForIngest keeps collectors separate', () => {
  const buckets = aggregateForIngest([
    makeRow({ source: 'claude', model: 'claude-opus-4-6', collector: 'claude-code-cli' }),
    makeRow({
      source: 'claude',
      model: 'claude-opus-4-6',
      collector: 'claude-desktop',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    }),
  ]);
  assert.equal(buckets.length, 2);
  const collectors = new Set(buckets.map((b) => b.collector));
  assert.ok(collectors.has('claude-code-cli'));
  assert.ok(collectors.has('claude-desktop'));
});

test('bucketToIngestEvent prefers bucket.collector', () => {
  const deviceId = '550e8400-e29b-41d4-a716-446655440000';
  const [bucket] = aggregateForIngest([
    makeRow({
      source: 'claude',
      model: 'claude-opus-4-6',
      collector: 'claude-desktop',
    }),
  ]);
  const event = bucketToIngestEvent(bucket!, deviceId);
  assert.ok(event);
  assert.equal(event.integration, 'claude-code');
  assert.equal(event.collector, 'claude-desktop');
});

test('bucketToIngestEvent maps qoder and trae integrations', () => {
  const deviceId = '550e8400-e29b-41d4-a716-446655440000';
  const q = bucketToIngestEvent(
    aggregateForIngest([
      makeRow({ source: 'qoder', model: 'auto', collector: 'qoder-cn-ide' }),
    ])[0]!,
    deviceId,
  );
  const t = bucketToIngestEvent(
    aggregateForIngest([
      makeRow({ source: 'trae', model: 'kimi-k2.5', collector: 'trae-cn-ide' }),
    ])[0]!,
    deviceId,
  );
  assert.equal(q?.integration, 'qoder');
  assert.equal(q?.collector, 'qoder-cn-ide');
  assert.equal(t?.integration, 'trae');
  assert.equal(t?.collector, 'trae-cn-ide');
});

test('parseClaudeIncremental tags cli vs desktop collectors', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-claude-collectors-'));
  const cliProjects = join(tempHome, '.claude', 'projects', 'proj-cli');
  const desktopProjects = join(
    tempHome,
    'Library',
    'Application Support',
    'Claude',
    'local-agent-mode-sessions',
    'sess1',
    '.claude',
    'projects',
    'proj-desk',
  );
  await mkdir(cliProjects, { recursive: true });
  await mkdir(desktopProjects, { recursive: true });

  const cliLine = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-02T09:24:36.557Z',
    requestId: 'req_cli',
    message: {
      id: 'msg_cli',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  const deskLine = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-02T09:24:36.557Z',
    requestId: 'req_desk',
    message: {
      id: 'msg_desk',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 20,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  await writeFile(join(cliProjects, 'a.jsonl'), `${cliLine}\n`);
  await writeFile(join(desktopProjects, 'b.jsonl'), `${deskLine}\n`);

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    const { result } = await parseClaudeIncremental({}, '2026-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 2);
    const byCollector = new Map(result.buckets.map((b) => [b.collector, b]));
    assert.equal(byCollector.get(CLAUDE_COLLECTOR_CLI)?.input_tokens, 10);
    assert.equal(byCollector.get(CLAUDE_COLLECTOR_DESKTOP)?.input_tokens, 20);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

test('parseQoderIncremental reads IDE local.db with collector split', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-qoder-'));
  const cnDbDir = join(
    tempHome,
    'Library',
    'Application Support',
    'QoderCN',
    'SharedClientCache',
    'cache',
    'db',
  );
  const intlDbDir = join(
    tempHome,
    'Library',
    'Application Support',
    'Qoder',
    'SharedClientCache',
    'cache',
    'db',
  );
  await mkdir(cnDbDir, { recursive: true });
  await mkdir(intlDbDir, { recursive: true });

  function seedDb(dbPath: string, id: string, prompt: number) {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE chat_session (
        session_id varchar(64) primary key,
        user_id VARCHAR(64) not null,
        session_title varchar(256) not null,
        project_id varchar(64) not null,
        project_uri varchar(512),
        project_name varchar(64),
        gmt_create INTEGER
      );
      CREATE TABLE chat_message (
        id varchar(64) primary key,
        session_id VARCHAR(64),
        role VARCHAR(64),
        token_info text,
        model_info text,
        gmt_create INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO chat_session (session_id, user_id, session_title, project_id, project_name, gmt_create)
       VALUES (?, 'u', 't', 'p', 'demo', 1784809186532)`,
    ).run('sess-1');
    db.prepare(
      `INSERT INTO chat_message (id, session_id, role, token_info, model_info, gmt_create)
       VALUES (?, 'sess-1', 'assistant', ?, '{"model_key":"auto"}', 1784809186532)`,
    ).run(
      id,
      JSON.stringify({
        prompt_tokens: prompt,
        completion_tokens: 5,
        cached_tokens: 100,
      }),
    );
    db.close();
  }

  seedDb(join(cnDbDir, 'local.db'), 'msg-cn', 1100);
  seedDb(join(intlDbDir, 'local.db'), 'msg-intl', 2100);

  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    const { result } = await parseQoderIncremental({}, '2020-01-01T00:00:00.000Z');
    assert.equal(result.eventsParsed, 2);
    const byCollector = new Map(result.buckets.map((b) => [b.collector, b]));
    assert.equal(byCollector.get('qoder-cn-ide')?.input_tokens, 1000);
    assert.equal(byCollector.get('qoder-cn-ide')?.cached_input_tokens, 100);
    assert.equal(byCollector.get('qoder-cn-ide')?.output_tokens, 5);
    assert.equal(byCollector.get('qoder-ide')?.input_tokens, 2000);
    assert.equal(result.buckets.every((b) => b.source === 'qoder'), true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

function encryptPage(key: Buffer, plaintextPage: Buffer, pageNumber: number): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const out = Buffer.alloc(PAGE_SIZE);
  if (pageNumber === 1) {
    // salt + encrypted body (without header) + reserve
    const salt = randomBytes(SALT_SIZE);
    salt.copy(out, 0);
    const body = plaintextPage.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE);
    const enc = Buffer.concat([cipher.update(body), cipher.final()]);
    enc.copy(out, SALT_SIZE);
  } else {
    const body = plaintextPage.subarray(0, PAGE_SIZE - RESERVE_SIZE);
    const enc = Buffer.concat([cipher.update(body), cipher.final()]);
    enc.copy(out, 0);
  }
  iv.copy(out, PAGE_SIZE - RESERVE_SIZE);
  return out;
}

test('trae decrypt + parseTraeIncremental via env decrypted db', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ai-usage-trae-'));
  const plainPath = join(temp, 'plain.db');
  const db = new DatabaseSync(plainPath);
  db.exec(`
    CREATE TABLE chat_turn (
      id TEXT PRIMARY KEY,
      context TEXT,
      created_at TEXT,
      project_path TEXT
    );
  `);
  db.prepare(
    `INSERT INTO chat_turn (id, context, created_at, project_path) VALUES (?, ?, ?, ?)`,
  ).run(
    'turn-1',
    JSON.stringify({
      token_usage: {
        prompt_tokens: 15012,
        completion_tokens: 312,
        reasoning_tokens: 0,
        cache_read_input_tokens: 12000,
        cache_creation_input_tokens: 0,
      },
      persist_user_message_context: {
        model_info: { config_name: 'kimi-k2.5' },
      },
    }),
    '2026-05-02T09:24:36.557Z',
    '/Users/me/proj',
  );
  db.close();

  process.env.TRAE_DECRYPTED_DB_TRAE_CN_IDE = plainPath;
  const prevHome = process.env.HOME;
  process.env.HOME = temp; // no encrypted DBs under fake home
  try {
    const { result } = await parseTraeIncremental({}, '2020-01-01T00:00:00.000Z', {
      dataDir: temp,
    });
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.skipped, undefined);
    const bucket = result.buckets[0]!;
    assert.equal(bucket.source, 'trae');
    assert.equal(bucket.collector, 'trae-cn-ide');
    assert.equal(bucket.model, 'kimi-k2.5');
    assert.equal(bucket.input_tokens, 3012);
    assert.equal(bucket.cached_input_tokens, 12000);
    assert.equal(bucket.output_tokens, 312);
  } finally {
    delete process.env.TRAE_DECRYPTED_DB_TRAE_CN_IDE;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test('parseTraeIncremental keeps dedup beyond 50k turns and prunes deleted rows', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ai-usage-trae-cap-'));
  const plainPath = join(temp, 'plain.db');
  const db = new DatabaseSync(plainPath);
  db.exec(`
    CREATE TABLE chat_turn (
      id TEXT PRIMARY KEY,
      context TEXT,
      created_at TEXT,
      project_path TEXT
    );
  `);
  const context = JSON.stringify({
    token_usage: { prompt_tokens: 80, completion_tokens: 20 },
    persist_user_message_context: { model_info: { config_name: 'kimi-k2.5' } },
  });
  const insert = db.prepare(
    'INSERT INTO chat_turn (id, context, created_at, project_path) VALUES (?, ?, ?, ?)',
  );
  const TOTAL = 50_050;
  db.exec('BEGIN');
  for (let i = 0; i < TOTAL; i++) {
    insert.run(
      `turn-${String(i).padStart(6, '0')}`,
      context,
      '2026-05-02T09:24:36.557Z',
      '/Users/me/proj',
    );
  }
  db.exec('COMMIT');
  db.close();

  process.env.TRAE_DECRYPTED_DB_TRAE_CN_IDE = plainPath;
  const prevHome = process.env.HOME;
  process.env.HOME = temp; // no encrypted DBs under fake home
  try {
    const cursors = {};
    const since = '2020-01-01T00:00:00.000Z';
    const first = await parseTraeIncremental(cursors, since, { dataDir: temp });
    assert.equal(first.result.eventsParsed, TOTAL);
    assert.equal(first.cursors.trae!.seenHashes!.length, TOTAL);

    // The old `.slice(-50_000)` dropped the oldest ids here, so the next full
    // scan re-counted them; the dedup set must survive past the old cap.
    const second = await parseTraeIncremental(cursors, since, { dataDir: temp });
    assert.equal(second.result.eventsParsed, 0);

    // Rows deleted upstream leave the dedup set without causing re-counts.
    const db2 = new DatabaseSync(plainPath);
    db2.exec("DELETE FROM chat_turn WHERE id < 'turn-000100'");
    db2.close();
    const third = await parseTraeIncremental(cursors, since, { dataDir: temp });
    assert.equal(third.result.eventsParsed, 0);
    assert.equal(third.cursors.trae!.seenHashes!.length, TOTAL - 100);

    // A round where the DB is unavailable keeps the dedup state, and
    // recovery does not re-count anything.
    process.env.TRAE_DECRYPTED_DB_TRAE_CN_IDE = join(temp, 'missing.db');
    const offline = await parseTraeIncremental(cursors, since, { dataDir: temp });
    assert.equal(offline.result.eventsParsed, 0);
    assert.equal(offline.cursors.trae!.seenHashes!.length, TOTAL - 100);
    process.env.TRAE_DECRYPTED_DB_TRAE_CN_IDE = plainPath;
    const recovered = await parseTraeIncremental(cursors, since, { dataDir: temp });
    assert.equal(recovered.result.eventsParsed, 0);
  } finally {
    delete process.env.TRAE_DECRYPTED_DB_TRAE_CN_IDE;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test('parseTraeIncremental skips when encrypted DB exists but key missing', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'ai-usage-trae-nokey-'));
  const dbDir = join(
    tempHome,
    'Library',
    'Application Support',
    'Trae CN',
    'ModularData',
    'ai-agent',
  );
  await mkdir(dbDir, { recursive: true });
  // Not a real SQLCipher DB — existence alone triggers key-required skip.
  await writeFile(join(dbDir, 'database.db'), Buffer.alloc(PAGE_SIZE));

  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    const dataDir = join(tempHome, '.ai-usage');
    await mkdir(dataDir, { recursive: true });
    const { result } = await parseTraeIncremental({}, '2020-01-01T00:00:00.000Z', {
      dataDir,
    });
    assert.equal(result.skipped, true);
    assert.ok(result.error?.includes('trae-cn-ide'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test('verifyTraeSqlcipherKey accepts round-trip encrypted page', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ai-usage-trae-key-'));
  const key = randomBytes(32);
  const plainPage = Buffer.alloc(PAGE_SIZE, 0);
  Buffer.from('SQLite format 3\0').copy(plainPage, 0);
  plainPage.writeUInt16BE(4096, 16); // page size
  const encPath = join(temp, 'database.db');
  writeFileSync(encPath, encryptPage(key, plainPage, 1));
  assert.equal(verifyTraeSqlcipherKey(encPath, key), true);
  assert.equal(verifyTraeSqlcipherKey(encPath, randomBytes(32)), false);

  const keyPath = join(temp, 'key.json');
  saveTraeSqlcipherKeyFile(keyPath, key.toString('hex'), { source: 'test' });
  const outPath = join(temp, 'out.db');
  await decryptTraeDatabase(encPath, key, outPath);
  const header = readFileSync(outPath).subarray(0, 16);
  assert.equal(header.toString('utf8'), 'SQLite format 3\0');
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { parseCodexIncremental } from '../src/parsers/codex.js';
import {
  CODEX_LEDGER_COLLECTOR,
  codexLedgerDbPaths,
  readCodexLedgerThreads,
} from '../src/parsers/codex-ledger.js';
import { codexHomeCandidates } from '../src/paths.js';
import { bucketToIngestEvent } from '../src/upload/events.js';
import type { CursorsFile, QueueBucket } from '../src/types.js';

const SINCE = '2026-01-01T00:00:00.000Z';

const CODEX_ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'AI_USAGE_CODEX_HOME'] as const;

type CodexEnvSnapshot = Record<(typeof CODEX_ENV_KEYS)[number], string | undefined>;

function snapshotCodexEnv(): CodexEnvSnapshot {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    AI_USAGE_CODEX_HOME: process.env.AI_USAGE_CODEX_HOME,
  };
}

function restoreCodexEnv(snapshot: CodexEnvSnapshot): void {
  for (const key of CODEX_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

/** Pin HOME + CODEX_HOME to a temp tree so discovery cannot see the developer's real Codex. */
async function withIsolatedCodexHome<T>(tempHome: string, fn: () => Promise<T>): Promise<T> {
  const snapshot = snapshotCodexEnv();
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.CODEX_HOME = join(tempHome, '.codex');
  delete process.env.AI_USAGE_CODEX_HOME;
  try {
    return await fn();
  } finally {
    restoreCodexEnv(snapshot);
  }
}

interface LedgerThreadFixture {
  id: string;
  rolloutPath: string;
  tokensUsed: number;
  model?: string;
  cwd?: string;
  recencyAtMs?: number;
  createdAtMs?: number;
  historyMode?: string;
}

function codexHome(tempHome: string): string {
  return join(tempHome, '.codex');
}

/** Build a ledger shaped like `~/.codex/state_5.sqlite`. */
async function createLedger(
  dbPath: string,
  threads: LedgerThreadFixture[],
  schema?: string,
): Promise<void> {
  await mkdir(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    schema ??
      `CREATE TABLE threads (
         id TEXT PRIMARY KEY,
         rollout_path TEXT NOT NULL,
         tokens_used INTEGER NOT NULL DEFAULT 0,
         model TEXT,
         cwd TEXT NOT NULL DEFAULT '',
         recency_at_ms INTEGER NOT NULL DEFAULT 0,
         created_at_ms INTEGER,
         history_mode TEXT NOT NULL DEFAULT 'legacy'
       );`,
  );
  if (!schema && threads.length > 0) {
    const insert = db.prepare(
      `INSERT INTO threads
         (id, rollout_path, tokens_used, model, cwd, recency_at_ms, created_at_ms, history_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const thread of threads) {
      insert.run(
        thread.id,
        thread.rolloutPath,
        thread.tokensUsed,
        thread.model ?? '',
        thread.cwd ?? '',
        thread.recencyAtMs ?? 0,
        thread.createdAtMs ?? 0,
        thread.historyMode ?? 'legacy',
      );
    }
  }
  db.close();
}

function ledgerBuckets(buckets: QueueBucket[]): QueueBucket[] {
  return buckets.filter((bucket) => bucket.collector === CODEX_LEDGER_COLLECTOR);
}

function ledgerRolloutPath(tempHome: string, name: string): string {
  return join(codexHome(tempHome), 'sessions', '2026', '06', '09', name);
}

const ROLLOUT_NAME = 'rollout-2026-06-09T20-46-00-019d4c1b-d561-7881-bc6b-0af7ad075ae7.jsonl';

const ROLLOUT_JSONL = [
  '{"type":"session_meta","payload":{"id":"live-session","cwd":"/Users/dev/my-app"}}',
  '{"timestamp":"2026-06-09T20:46:30.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":60},"model":"gpt-5.6-sol"}}}',
].join('\n');

test('readCodexLedgerThreads reads threads and ignores a database without one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-'));
  try {
    const dbPath = join(dir, 'state_5.sqlite');
    await createLedger(dbPath, [
      {
        id: 'thread-1',
        rolloutPath: '/tmp/rollout-a.jsonl',
        tokensUsed: 4321,
        model: 'gpt-5.6-sol',
        cwd: '/Users/dev/my-app',
        recencyAtMs: 1780000000000,
        createdAtMs: 1779000000000,
      },
      {
        id: '',
        rolloutPath: '/tmp/rollout-skipped.jsonl',
        tokensUsed: 1,
      },
    ]);
    assert.deepEqual(readCodexLedgerThreads(dbPath), [
      {
        id: 'thread-1',
        rolloutPath: '/tmp/rollout-a.jsonl',
        tokensUsed: 4321,
        model: 'gpt-5.6-sol',
        cwd: '/Users/dev/my-app',
        timestampMs: 1780000000000,
      },
    ]);

    const barePath = join(dir, 'state_4.sqlite');
    await createLedger(barePath, [], 'CREATE TABLE unrelated (id TEXT);');
    assert.deepEqual(readCodexLedgerThreads(barePath), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexLedgerThreads tolerates a ledger missing optional columns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-old-'));
  try {
    const dbPath = join(dir, 'state_5.sqlite');
    await createLedger(
      dbPath,
      [],
      `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, tokens_used INTEGER);`,
    );
    const db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO threads (id, rollout_path, tokens_used) VALUES ('t1', '/tmp/x.jsonl', 99);`);
    db.close();

    assert.deepEqual(readCodexLedgerThreads(dbPath), [
      { id: 't1', rolloutPath: '/tmp/x.jsonl', tokensUsed: 99, model: '', cwd: '', timestampMs: 0 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codexLedgerDbPaths lists ledgers and skips their WAL companions', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-paths-'));
  try {
    const home = codexHome(tempHome);
    await mkdir(home, { recursive: true });
    for (const name of ['state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm', 'state.sqlite']) {
      await writeFile(join(home, name), '');
    }
    await withIsolatedCodexHome(tempHome, async () => {
      const found = codexLedgerDbPaths().map((p) => p.slice(home.length + 1));
      assert.deepEqual(found, ['state.sqlite', 'state_5.sqlite']);
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental recovers a thread whose rollout file is gone', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-fallback-'));
  try {
    const rolloutPath = ledgerRolloutPath(tempHome, ROLLOUT_NAME);
    await createLedger(join(codexHome(tempHome), 'state_5.sqlite'), [
      {
        id: 'vanished-thread',
        rolloutPath,
        tokensUsed: 9_876_543,
        model: 'gpt-5.6-terra',
        cwd: '/Users/dev/alipay-service',
        // 2026-06-09T20:47:00.000Z
        recencyAtMs: Date.parse('2026-06-09T20:47:00.000Z'),
      },
    ]);

    await withIsolatedCodexHome(tempHome, async () => {
      const { result } = await parseCodexIncremental({}, SINCE);
      assert.equal(result.eventsParsed, 1);
      assert.equal(result.filesProcessed, 1);
      assert.equal(result.buckets.length, 1);

      const bucket = result.buckets[0]!;
      assert.equal(bucket.source, 'codex');
      assert.equal(bucket.collector, CODEX_LEDGER_COLLECTOR);
      assert.equal(bucket.model, 'gpt-5.6-terra');
      assert.equal(bucket.project, 'alipay-service');
      assert.equal(bucket.hour_start, '2026-06-09T20:30:00.000Z');
      // The ledger keeps one lifetime total with no input/output split.
      assert.equal(bucket.input_tokens, 9_876_543);
      assert.equal(bucket.output_tokens, 0);
      assert.equal(bucket.cached_input_tokens, 0);
      assert.equal(bucket.total_tokens, 9_876_543);
      assert.equal(bucket.conversation_count, 1);
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental reports a vanished rollout once, then stays incremental', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-once-'));
  try {
    const dbPath = join(codexHome(tempHome), 'state_5.sqlite');
    await createLedger(dbPath, [
      {
        id: 'growing-thread',
        rolloutPath: ledgerRolloutPath(tempHome, ROLLOUT_NAME),
        tokensUsed: 1_000,
        model: 'gpt-5.6-sol',
        cwd: '/Users/dev/my-app',
        recencyAtMs: Date.parse('2026-06-09T20:47:00.000Z'),
      },
    ]);

    await withIsolatedCodexHome(tempHome, async () => {
      const cursors: CursorsFile = {};
      const first = await parseCodexIncremental(cursors, SINCE);
      assert.equal(first.result.buckets[0]?.input_tokens, 1_000);
      assert.deepEqual(cursors.codex?.ledgerTotals, { 'growing-thread': { tokens: 1_000 } });

      // Re-reading an unchanged ledger must not re-add the same tokens.
      delete cursors.codex!.dbMtimes;
      const second = await parseCodexIncremental(cursors, SINCE);
      assert.equal(second.result.eventsParsed, 0);
      assert.equal(second.result.buckets.length, 0);

      // A later total only reports the growth, and is no longer a new thread.
      const db = new DatabaseSync(dbPath);
      db.exec(`UPDATE threads SET tokens_used = 1_600 WHERE id = 'growing-thread';`);
      db.close();
      delete cursors.codex!.dbMtimes;
      const third = await parseCodexIncremental(cursors, SINCE);
      assert.equal(third.result.eventsParsed, 1);
      assert.equal(third.result.buckets[0]?.input_tokens, 600);
      assert.equal(third.result.buckets[0]?.conversation_count, 0);
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental keeps the ledger silent while the rollout still exists', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-present-'));
  try {
    const rolloutPath = ledgerRolloutPath(tempHome, ROLLOUT_NAME);
    await mkdir(join(rolloutPath, '..'), { recursive: true });
    await writeFile(rolloutPath, `${ROLLOUT_JSONL}\n`, 'utf8');
    await createLedger(join(codexHome(tempHome), 'state_5.sqlite'), [
      {
        id: 'live-thread',
        rolloutPath,
        tokensUsed: 60,
        model: 'gpt-5.6-sol',
        cwd: '/Users/dev/my-app',
        recencyAtMs: Date.parse('2026-06-09T20:46:30.000Z'),
      },
    ]);

    await withIsolatedCodexHome(tempHome, async () => {
      const { result } = await parseCodexIncremental({}, SINCE);
      assert.equal(result.eventsParsed, 1);
      assert.equal(result.buckets.length, 1);
      // The rollout owns this thread; the ledger must not add a second row.
      assert.equal(result.buckets[0]?.collector, undefined);
      assert.equal(result.buckets[0]?.input_tokens, 50);
      assert.equal(ledgerBuckets(result.buckets).length, 0);
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental does not re-add a rollout counted before it vanished', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-counted-'));
  try {
    const rolloutPath = ledgerRolloutPath(tempHome, ROLLOUT_NAME);
    const dbPath = join(codexHome(tempHome), 'state_5.sqlite');
    await mkdir(join(rolloutPath, '..'), { recursive: true });
    await writeFile(rolloutPath, `${ROLLOUT_JSONL}\n`, 'utf8');

    await withIsolatedCodexHome(tempHome, async () => {
      const cursors: CursorsFile = {};
      const before = await parseCodexIncremental(cursors, SINCE);
      assert.equal(before.result.buckets[0]?.input_tokens, 50);

      // Codex registers the thread and removes the rollout it already read.
      await unlink(rolloutPath);
      await createLedger(dbPath, [
        {
          id: 'counted-thread',
          rolloutPath,
          tokensUsed: 60,
          model: 'gpt-5.6-sol',
          cwd: '/Users/dev/my-app',
          recencyAtMs: Date.parse('2026-06-09T20:46:30.000Z'),
        },
      ]);
      delete cursors.codex!.dbMtimes;

      const after = await parseCodexIncremental(cursors, SINCE);
      assert.equal(after.result.buckets.length, 0);
      assert.deepEqual(cursors.codex?.ledgerTotals, { 'counted-thread': { tokens: 60 } });
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental skips ledger rows outside the collection window', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-window-'));
  try {
    await createLedger(join(codexHome(tempHome), 'state_5.sqlite'), [
      {
        id: 'stale-thread',
        rolloutPath: ledgerRolloutPath(tempHome, 'rollout-2026-01-04T02-00-00-old.jsonl'),
        tokensUsed: 500,
        model: 'gpt-5.4',
        cwd: '/Users/dev/old-app',
        recencyAtMs: Date.parse('2026-01-04T02:05:00.000Z'),
      },
      {
        id: 'recent-thread',
        rolloutPath: ledgerRolloutPath(tempHome, 'rollout-2026-06-09T20-46-00-recent.jsonl'),
        tokensUsed: 700,
        model: 'gpt-5.5',
        cwd: '/Users/dev/new-app',
        recencyAtMs: Date.parse('2026-07-01T09:00:00.000Z'),
      },
    ]);

    await withIsolatedCodexHome(tempHome, async () => {
      // Both rows are recorded so a later window widening cannot double count,
      // but only the in-window total is reported.
      const cursors: CursorsFile = {};
      const { result } = await parseCodexIncremental(cursors, '2026-06-01T00:00:00.000Z');
      assert.equal(result.eventsParsed, 1);
      assert.deepEqual(
        result.buckets.map((b) => [b.model, b.input_tokens]),
        [['gpt-5.5', 700]],
      );
      assert.deepEqual(cursors.codex?.ledgerTotals, {
        'stale-thread': { tokens: 500 },
        'recent-thread': { tokens: 700 },
      });
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental falls back to created_at_ms when recency is unset', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-created-'));
  try {
    await createLedger(join(codexHome(tempHome), 'state_5.sqlite'), [
      {
        id: 'created-thread',
        rolloutPath: ledgerRolloutPath(tempHome, 'rollout-2026-06-05T00-00-00-created.jsonl'),
        tokensUsed: 2_048,
        model: 'gpt-5.6-sol',
        cwd: '/Users/dev/my-app',
        recencyAtMs: 0,
        createdAtMs: Date.parse('2026-06-05T00:00:00.000Z'),
      },
      {
        id: 'undated-thread',
        rolloutPath: ledgerRolloutPath(tempHome, 'rollout-2026-06-05T00-00-00-undated.jsonl'),
        tokensUsed: 4_096,
        model: 'gpt-5.6-sol',
        cwd: '/Users/dev/my-app',
      },
    ]);

    await withIsolatedCodexHome(tempHome, async () => {
      const { result } = await parseCodexIncremental({}, SINCE);
      assert.equal(result.eventsParsed, 1);
      assert.equal(result.buckets.length, 1);
      assert.equal(result.buckets[0]?.hour_start, '2026-06-05T00:00:00.000Z');
      assert.equal(result.buckets[0]?.input_tokens, 2_048);
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental ignores a ledger without a threads table', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-broken-'));
  try {
    const rolloutPath = ledgerRolloutPath(tempHome, ROLLOUT_NAME);
    await mkdir(join(rolloutPath, '..'), { recursive: true });
    await writeFile(rolloutPath, `${ROLLOUT_JSONL}\n`, 'utf8');
    // A corrupt ledger must not stop rollout collection.
    await mkdir(codexHome(tempHome), { recursive: true });
    await writeFile(join(codexHome(tempHome), 'state_5.sqlite'), 'not a sqlite database', 'utf8');

    await withIsolatedCodexHome(tempHome, async () => {
      const { result } = await parseCodexIncremental({}, SINCE);
      assert.equal(result.eventsParsed, 1);
      assert.equal(result.buckets[0]?.input_tokens, 50);
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('parseCodexIncremental leaves no ledger cursor churn when Codex is absent', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-codex-ledger-absent-'));
  try {
    await withIsolatedCodexHome(tempHome, async () => {
      assert.deepEqual(codexHomeCandidates(), [codexHome(tempHome)]);
      const cursors: CursorsFile = {};
      const { result } = await parseCodexIncremental(cursors, SINCE);
      assert.equal(result.eventsParsed, 0);
      assert.equal(result.filesProcessed, 0);
      assert.deepEqual(cursors.codex?.ledgerTotals, {});
      assert.deepEqual(cursors.codex?.dbMtimes, {});
    });
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('bucketToIngestEvent maps the codex-ledger collector under the codex integration', () => {
  const event = bucketToIngestEvent(
    {
      hour_start: '2026-06-09T20:30:00.000Z',
      source: 'codex',
      model: 'gpt-5.6-sol',
      collector: CODEX_LEDGER_COLLECTOR,
      input_tokens: 1_000,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 1_000,
      conversation_count: 1,
    },
    '550e8400-e29b-41d4-a716-446655440000',
  );
  assert.equal(event?.integration, 'codex');
  assert.equal(event?.collector, CODEX_LEDGER_COLLECTOR);
  assert.equal(event?.usage.input_tokens, 1_000);
});

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parsePiDesktopIncremental } from '../src/parsers/pi-desktop.js';
import { resetSqliteQueryCache } from '../src/parsers/sqlite.js';
import { resetProjectNameCache } from '../src/project-name.js';
import { normalizeSyncSource } from '../src/sync/index.js';

const SINCE = '2026-10-20T00:00:00.000Z';
const STARTED_AT = Date.parse('2026-10-20T10:05:00.000Z');
const ENDED_AT = STARTED_AT + 60_000;

function usageJson(input: number, output: number, cacheRead: number, reasoning: number) {
  const total = input + output + cacheRead;
  return {
    aggregation: 'aggregate',
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    reasoningTokens: reasoning,
    totalTokens: total,
    operations: [
      {
        operationId: 'op-1',
        modelId: 'deepseek-v4.1-flash',
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        reasoningTokens: reasoning,
        totalTokens: total,
      },
    ],
  };
}

async function createDb(home: string): Promise<string> {
  await mkdir(home, { recursive: true });
  const dbPath = join(home, 'pi.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id INTEGER, deleted_at INTEGER);
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    INSERT INTO projects VALUES (1, '/work/alpha', 'alpha');
    INSERT INTO sessions VALUES ('s1', 1, NULL);`);
  db.close();
  return dbPath;
}

function insertTurn(
  dbPath: string,
  row: {
    id: string;
    modelId: string | null;
    usage: unknown;
    startedAt: number;
    endedAt: number | null;
    sessionId?: string;
  },
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO turns (id, session_id, model_id, usage_json, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.sessionId ?? 's1',
      row.modelId,
      row.usage == null ? null : JSON.stringify(row.usage),
      row.startedAt,
      row.endedAt,
    );
  } finally {
    db.close();
  }
}

test('PI-Desktop reads turns per operation and stays incremental', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-desktop-'));
  const previousHome = process.env.PI_DESKTOP_HOME;
  process.env.PI_DESKTOP_HOME = home;
  resetProjectNameCache();
  resetSqliteQueryCache();
  try {
    const dbPath = await createDb(home);
    insertTurn(dbPath, {
      id: 'turn-1',
      modelId: 'deepseek-v4.1-flash',
      usage: usageJson(100, 20, 30, 5),
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });
    resetSqliteQueryCache();

    const first = await parsePiDesktopIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    assert.equal(first.result.filesProcessed, 1);
    assert.deepEqual(
      first.result.buckets.map((row) => ({
        source: row.source,
        collector: row.collector,
        model: row.model,
        project: row.project,
        hour: row.hour_start,
        input: row.input_tokens,
        output: row.output_tokens,
        cached: row.cached_input_tokens,
        reasoning: row.reasoning_output_tokens,
        total: row.total_tokens,
        conversations: row.conversation_count,
      })),
      [
        {
          source: 'pi-desktop',
          collector: 'pi-desktop',
          model: 'deepseek-v4.1-flash',
          project: 'alpha',
          hour: '2026-10-20T10:00:00.000Z',
          input: 100,
          output: 20,
          cached: 30,
          reasoning: 5,
          // Five-field sum: PI-Desktop's own totalTokens excludes reasoning.
          total: 155,
          conversations: 1,
        },
      ],
    );

    // Same store, unchanged rows → no new buckets and no cursor churn.
    const cursorSnapshot = JSON.stringify(first.cursors);
    const again = await parsePiDesktopIncremental(first.cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
    assert.equal(again.result.buckets.length, 0);
    assert.equal(JSON.stringify(again.cursors), cursorSnapshot);

    // A running turn keeps growing; only the difference is appended.
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE turns SET usage_json = ?, ended_at = ? WHERE id = ?').run(
      JSON.stringify(usageJson(200, 20, 30, 5)),
      ENDED_AT + 60_000,
      'turn-1',
    );
    db.close();
    resetSqliteQueryCache();

    const grown = await parsePiDesktopIncremental(again.cursors, SINCE);
    assert.equal(grown.result.eventsParsed, 1);
    assert.equal(grown.result.buckets.length, 1);
    assert.equal(grown.result.buckets[0]?.input_tokens, 100);
    assert.equal(grown.result.buckets[0]?.total_tokens, 100);
    // Growth is booked as tokens only; the turn is not a second conversation.
    assert.equal(grown.result.buckets[0]?.conversation_count, 0);
  } finally {
    if (previousHome === undefined) delete process.env.PI_DESKTOP_HOME;
    else process.env.PI_DESKTOP_HOME = previousHome;
    resetSqliteQueryCache();
    resetProjectNameCache();
    await rm(home, { recursive: true, force: true });
  }
});

test('PI-Desktop falls back to the turn rollup and honours the collect window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-desktop-'));
  const previousHome = process.env.PI_DESKTOP_HOME;
  process.env.PI_DESKTOP_HOME = home;
  resetProjectNameCache();
  resetSqliteQueryCache();
  try {
    const dbPath = await createDb(home);
    // No operations[] (older store): the turn rollup carries the model id.
    insertTurn(dbPath, {
      id: 'turn-rollup',
      modelId: 'qwen3.8-max',
      usage: {
        aggregation: 'aggregate',
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 1,
        totalTokens: 14,
      },
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });
    // Outside the collect window → ignored, and no cursor state kept for it.
    insertTurn(dbPath, {
      id: 'turn-old',
      modelId: 'qwen3.8-max',
      usage: usageJson(999, 999, 999, 999),
      startedAt: Date.parse('2026-09-01T10:00:00.000Z'),
      endedAt: Date.parse('2026-09-01T10:01:00.000Z'),
    });
    resetSqliteQueryCache();

    const parsed = await parsePiDesktopIncremental({}, SINCE);
    assert.equal(parsed.result.eventsParsed, 1);
    assert.equal(parsed.result.buckets.length, 1);
    assert.equal(parsed.result.buckets[0]?.model, 'qwen3.8-max');
    assert.equal(parsed.result.buckets[0]?.total_tokens, 15);
    assert.deepEqual(Object.keys(parsed.cursors.piDesktop?.operations ?? {}), ['turn-rollup|qwen3.8-max']);
    assert.equal(normalizeSyncSource('pi-desktop'), 'pi-desktop');
    assert.equal(normalizeSyncSource('pidesktop'), 'pi-desktop');
    // The CLI agent source must not swallow the desktop one.
    assert.equal(normalizeSyncSource('pi'), 'pi');
  } finally {
    if (previousHome === undefined) delete process.env.PI_DESKTOP_HOME;
    else process.env.PI_DESKTOP_HOME = previousHome;
    resetSqliteQueryCache();
    resetProjectNameCache();
    await rm(home, { recursive: true, force: true });
  }
});

test('PI-Desktop tolerates an empty statsSince instead of building a NaN query', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-desktop-'));
  const previousHome = process.env.PI_DESKTOP_HOME;
  process.env.PI_DESKTOP_HOME = home;
  resetProjectNameCache();
  resetSqliteQueryCache();
  try {
    const dbPath = await createDb(home);
    insertTurn(dbPath, {
      id: 'turn-empty-since',
      modelId: 'qwen3.8-max',
      usage: usageJson(5, 2, 0, 0),
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });
    resetSqliteQueryCache();

    const parsed = await parsePiDesktopIncremental({}, '');
    assert.equal(parsed.result.eventsParsed, 1);
    assert.equal(parsed.result.buckets.length, 1);
    assert.equal(parsed.result.buckets[0]?.total_tokens, 7);
  } finally {
    if (previousHome === undefined) delete process.env.PI_DESKTOP_HOME;
    else process.env.PI_DESKTOP_HOME = previousHome;
    resetSqliteQueryCache();
    resetProjectNameCache();
    await rm(home, { recursive: true, force: true });
  }
});

test('PI-Desktop reports an unreadable store instead of breaking the sync round', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-desktop-'));
  const previousHome = process.env.PI_DESKTOP_HOME;
  process.env.PI_DESKTOP_HOME = home;
  resetSqliteQueryCache();
  try {
    await writeFile(join(home, 'pi.sqlite'), 'definitely not a sqlite database');
    resetSqliteQueryCache();

    const parsed = await parsePiDesktopIncremental({}, SINCE);
    assert.equal(parsed.result.skipped, true);
    assert.equal(parsed.result.buckets.length, 0);
    assert.equal(parsed.result.eventsParsed, 0);
    assert.match(parsed.result.error ?? '', /PI-Desktop/);
  } finally {
    if (previousHome === undefined) delete process.env.PI_DESKTOP_HOME;
    else process.env.PI_DESKTOP_HOME = previousHome;
    resetSqliteQueryCache();
    resetProjectNameCache();
    await rm(home, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { parseKinetaiosIncremental } from '../src/parsers/kinetaios.js';
import { bucketToIngestEvent } from '../src/upload/events.js';

const SINCE = '2020-01-01T00:00:00.000Z';

/** 建一个与 KinetAios v3.6.4+ 同构的最小 history.db(cost_log + conversations)。 */
async function makeDb(rows: Array<[string, number, number, number, string | null, string | null]>) {
  const dir = await mkdtemp(join(tmpdir(), 'tud-kinetaios-'));
  const dbPath = join(dir, 'history.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE conversations(
    id TEXT PRIMARY KEY, engine TEXT, cwd TEXT, model TEXT);
  CREATE TABLE cost_log(
    id TEXT PRIMARY KEY, conv_id TEXT, engine TEXT, amount REAL, tokens INTEGER, ts REAL,
    tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0);`);
  for (const [convId, , , , model, cwd] of rows) {
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run(convId, 'direct', cwd, model);
  }
  db.close();
  return dbPath;
}

void makeDb;

test('parseKinetaiosIncremental reads cost_log with model/cwd join + reported cost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-kinetaios-'));
  const dbPath = join(dir, 'history.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY, engine TEXT, cwd TEXT, model TEXT);
  CREATE TABLE cost_log(
    id TEXT PRIMARY KEY, conv_id TEXT, engine TEXT, amount REAL, tokens INTEGER, ts REAL,
    tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0);`);
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run(
    'c1', 'direct', '/Users/me/demo', 'glm-5.3-flash',
  );
  db.prepare('INSERT INTO cost_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'r1', 'c1', 'direct', 0.05, 120, Date.parse('2026-09-23T10:00:00.000Z'), 100, 20,
  );
  db.close();

  const prev = process.env.AI_USAGE_KINETAIOS_DB;
  process.env.AI_USAGE_KINETAIOS_DB = dbPath;
  try {
    const { result, cursors } = await parseKinetaiosIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.filesProcessed, 1);
    const b = result.buckets[0]!;
    assert.equal(b.source, 'kinetaios');
    assert.equal(b.collector, 'kinetaios');
    assert.equal(b.model, 'glm-5.3-flash');
    assert.equal(b.input_tokens, 100);
    assert.equal(b.output_tokens, 20);
    assert.equal(b.total_tokens, 120);
    assert.equal(b.reported_cost_usd, 0.05);
    assert.ok(b.project && b.project !== 'unknown');

    // 幂等:同 cursor 再跑一遍 → 零新事件
    const again = await parseKinetaiosIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
    assert.equal(again.result.buckets.length, 0);

    // 上报事件:source → integration 映射存在,collector 透传
    const ev = bucketToIngestEvent({ ...b, hour_start: b.hour_start }, '550e8400-e29b-41d4-a716-446655440000');
    assert.ok(ev, 'ingest event should build');
    assert.equal(ev!.integration, 'kinetaios');
    assert.equal(ev!.collector, 'kinetaios');
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_KINETAIOS_DB;
    else process.env.AI_USAGE_KINETAIOS_DB = prev;
  }
});

test('parseKinetaiosIncremental dedups same-millisecond rows via seenIds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-kinetaios-'));
  const dbPath = join(dir, 'history.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY, engine TEXT, cwd TEXT, model TEXT);
  CREATE TABLE cost_log(
    id TEXT PRIMARY KEY, conv_id TEXT, engine TEXT, amount REAL, tokens INTEGER, ts REAL,
    tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0);`);
  const ts = Date.parse('2026-09-23T11:30:05.000Z'); // 同一半小时桶、同一毫秒
  db.prepare('INSERT INTO cost_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('a1', 'c1', 'direct', 0.01, 10, ts, 8, 2);
  db.prepare('INSERT INTO cost_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('a2', 'c1', 'direct', 0.02, 20, ts, 15, 5);
  db.close();

  const prev = process.env.AI_USAGE_KINETAIOS_DB;
  process.env.AI_USAGE_KINETAIOS_DB = dbPath;
  try {
    const { result, cursors } = await parseKinetaiosIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 2);
    const b = result.buckets[0]!;
    assert.equal(b.input_tokens, 23);
    assert.equal(b.output_tokens, 7);
    assert.ok(Math.abs(b.reported_cost_usd! - 0.03) < 1e-9);

    const again = await parseKinetaiosIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_KINETAIOS_DB;
    else process.env.AI_USAGE_KINETAIOS_DB = prev;
  }
});

test('parseKinetaiosIncremental skips missing db', async () => {
  const prev = process.env.AI_USAGE_KINETAIOS_DB;
  process.env.AI_USAGE_KINETAIOS_DB = '/nonexistent/kinetaios/history.db';
  try {
    const { result } = await parseKinetaiosIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 0);
    assert.equal(result.buckets.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_KINETAIOS_DB;
    else process.env.AI_USAGE_KINETAIOS_DB = prev;
  }
});

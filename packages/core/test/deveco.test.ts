import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseDevecoIncremental } from '../src/parsers/deveco.js';
import { parseOpencodeIncremental } from '../src/parsers/opencode.js';
import { devecoDataDir } from '../src/paths.js';
import { isSyncSourcePresent } from '../src/sync/source-presence.js';
import { normalizeSyncSource, syncAll } from '../src/sync/index.js';
import { aggregateForIngest } from '../src/aggregate.js';
import { bucketToIngestEvent } from '../src/upload/events.js';
import { loadRecentBuckets } from '../src/queue/index.js';
import type { TudConfig } from '../src/types.js';

const SINCE = '2020-01-01T00:00:00.000Z';
const created = Date.parse('2026-10-10T06:50:00.000Z');
const sample = {
  role: 'assistant', modelID: 'deepseek-flash', time: { created, completed: created + 1000 },
  tokens: { total: 26253, input: 26163, output: 9, reasoning: 81, cache: { read: 0, write: 0 } },
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'tud-deveco-'));
  const previous = process.env.AI_USAGE_DEVECO_HOME;
  process.env.AI_USAGE_DEVECO_HOME = dir;
  const db = new DatabaseSync(join(dir, 'deveco.db'));
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, tokens_input INTEGER);`);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('ses_a', '/projects/harmony-app', '', 999999);
  return { dir, db, async close() {
    db.close();
    if (previous === undefined) delete process.env.AI_USAGE_DEVECO_HOME;
    else process.env.AI_USAGE_DEVECO_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  } };
}

function message(db: DatabaseSync, id: string, data: unknown) {
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run(id, 'ses_a', JSON.stringify(data));
}
function projection(db: DatabaseSync, id: string, type: string, data: unknown) {
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)').run(id, 'ses_a', type, JSON.stringify(data));
}

test('DevEco reads real-shaped usage and ignores session totals and zero-token messages', async () => {
  const f = await fixture();
  try {
    message(f.db, 'msg_a', sample);
    message(f.db, 'msg_zero', { ...sample, tokens: { input: 0, output: 0 } });
    message(f.db, 'msg_user', { ...sample, role: 'user' });
    projection(f.db, 'msg_a', 'model-switched', { model: { id: 'deepseek-flash' } });
    const first = await parseDevecoIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    const row = first.result.buckets[0]!;
    assert.equal(row.source, 'deveco');
    assert.equal(row.collector, 'deveco-code');
    assert.equal(row.model, 'deepseek-flash');
    assert.equal(row.project, 'harmony-app');
    assert.equal(row.total_tokens, 26253);
    assert.equal(row.input_tokens, 26163);
    assert.equal(row.output_tokens, 9);
    assert.equal(row.reasoning_output_tokens, 81);
    assert.equal(row.local_metrics?.requestCount, 1);
    assert.equal(isSyncSourcePresent('deveco'), true);
    assert.equal(normalizeSyncSource('deveco-code'), 'deveco');
    const event = bucketToIngestEvent(aggregateForIngest([row])[0]!, 'device');
    assert.equal(event?.integration, 'deveco');
    assert.equal(event?.collector, 'deveco-code');
    assert.equal((await parseDevecoIncremental(first.cursors, SINCE)).result.eventsParsed, 0);

    const increased = { ...sample, tokens: { input: 26173, output: 11, reasoning: 84, cache: { read: 4, write: 5 } } };
    f.db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify(increased), 'msg_a');
    const next = await parseDevecoIncremental(first.cursors, SINCE);
    assert.equal(next.result.buckets[0]!.total_tokens, 24);
    assert.equal(next.result.buckets[0]!.cached_input_tokens, 4);
    assert.equal(next.result.buckets[0]!.cache_creation_input_tokens, 5);
    assert.equal(next.result.buckets[0]!.local_metrics?.requestCount, 0);
    assert.equal((await parseDevecoIncremental(next.cursors, SINCE)).result.eventsParsed, 0);
  } finally { await f.close(); }
});

test('DevEco counts projected calls and compaction once, with isolated OpenCode cursors', async () => {
  const f = await fixture();
  const oldOpenCode = process.env.OPENCODE_HOME;
  process.env.OPENCODE_HOME = f.dir;
  try {
    message(f.db, 'msg_a', sample);
    projection(f.db, 'msg_a', 'assistant', sample);
    projection(f.db, 'msg_compact', 'compaction', { ...sample, modelID: undefined, model: { id: 'deepseek-flash' }, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } } });
    message(f.db, 'msg_pending', { ...sample, tokens: { input: 1, output: 1 } });
    projection(f.db, 'msg_pending', 'assistant', { time: { created } });
    const result = await parseDevecoIncremental({}, SINCE);
    assert.equal(result.result.eventsParsed, 3);
    assert.equal(result.result.buckets[0]!.total_tokens, 26275);
    assert.equal(result.result.buckets[0]!.local_metrics?.requestCount, 3);
    const open = new DatabaseSync(join(f.dir, 'opencode.db'));
    open.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
    message(open, 'msg_a', sample);
    open.close();
    const other = await parseOpencodeIncremental(result.cursors, SINCE);
    assert.equal(other.result.eventsParsed, 1);
    assert.equal(other.result.buckets[0]!.source, 'opencode');
    assert.equal((await parseDevecoIncremental(other.cursors, SINCE)).result.eventsParsed, 0);
  } finally {
    if (oldOpenCode === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = oldOpenCode;
    await f.close();
  }
});

test('DevEco filters historical usage and reports unreadable schemas', async () => {
  const f = await fixture();
  try {
    message(f.db, 'msg_old', sample);
    assert.equal((await parseDevecoIncremental({}, '2026-10-11T00:00:00Z')).result.eventsParsed, 0);
    f.db.exec('DROP TABLE message; DROP TABLE session_message;');
    const result = await parseDevecoIncremental({}, SINCE);
    assert.equal(result.result.skipped, true);
    assert.match(result.result.error!, /no supported message tables/);
  } finally { await f.close(); }
});

test('DevEco synchronizes into the local queue once', async () => {
  const f = await fixture();
  try {
    message(f.db, 'msg_a', sample);
    const dataDir = join(f.dir, 'usage');
    const config: TudConfig = { deviceId: 'device', hostname: 'test', dataDir, statsSince: SINCE,
      juejin: { enabled: false, apiUrl: 'https://example.invalid', authMode: 'bearer', token: null } };
    const first = await syncAll(dataDir, config, 'deveco');
    assert.equal(first[0]!.eventsParsed, 1);
    const second = await syncAll(dataDir, config, 'deveco');
    assert.equal(second[0]!.eventsParsed, 0);
    const rows = await loadRecentBuckets(dataDir, SINCE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.total_tokens, 26253);
  } finally { await f.close(); }
});

test('DevEco supports XDG data roots and an explicit collector override', () => {
  const old = process.env.AI_USAGE_DEVECO_HOME;
  const xdg = process.env.XDG_DATA_HOME;
  try {
    delete process.env.AI_USAGE_DEVECO_HOME;
    process.env.XDG_DATA_HOME = join(tmpdir(), 'xdg-data');
    assert.equal(devecoDataDir(), join(tmpdir(), 'xdg-data', 'deveco'));
    process.env.AI_USAGE_DEVECO_HOME = join(tmpdir(), 'custom-deveco');
    assert.equal(devecoDataDir(), join(tmpdir(), 'custom-deveco'));
  } finally {
    if (old === undefined) delete process.env.AI_USAGE_DEVECO_HOME; else process.env.AI_USAGE_DEVECO_HOME = old;
    if (xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = xdg;
  }
});


test('DevEco supports legacy databases with no projection or session tables', async () => {
  const f = await fixture();
  try {
    f.db.exec('DROP TABLE session_message; DROP TABLE session;');
    message(f.db, 'msg_legacy', { ...sample, path: { cwd: '/projects/legacy-app' } });
    const result = await parseDevecoIncremental({}, SINCE);
    assert.equal(result.result.eventsParsed, 1);
    assert.equal(result.result.buckets[0]!.project, 'legacy-app');
  } finally {
    await f.close();
  }
});

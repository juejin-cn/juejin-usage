import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  aggregateLocalMetrics,
  metricsFromBucket,
} from '../src/local-metrics.js';
import { sumTokenTotals } from '../src/parsers/shared.js';
import { resetSqliteQueryCache } from '../src/parsers/sqlite.js';
import { parseCodeartsAgentIncremental } from '../src/parsers/codearts-agent.js';
import { clearCursors, loadRecentBuckets } from '../src/queue/index.js';
import { syncAll } from '../src/sync/index.js';
import type { CursorsFile, QueueBucket } from '../src/types.js';

const SINCE = '2026-07-01T00:00:00.000Z';
const CREATED = Date.parse('2026-07-25T09:00:00.000Z');
const ROOT = '/tmp/codearts-fixture';

type TableName = 'message' | 'session_message';

interface Fixture {
  dir: string;
  dbPath: string;
}

function baseTokens(output = 10): Record<string, unknown> {
  return {
    input: 30,
    output,
    reasoning: 3,
    cache: { read: 5, write: 2 },
  };
}

function legacyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    modelID: 'deepseek-r1',
    time: { created: CREATED, completed: CREATED },
    tokens: baseTokens(),
    path: { root: ROOT },
    ...overrides,
  };
}

function v2Payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: { created: CREATED, completed: CREATED },
    model: { id: 'deepseek-r1', providerID: 'huaweicloud' },
    tokens: baseTokens(),
    path: { root: ROOT },
    ...overrides,
  };
}

function overrideEnv(t: TestContext, overrides: Record<string, string>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function writeDb(dbPath: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
  resetSqliteQueryCache();
}

async function createFixture(t: TestContext, tables: TableName[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'jusage-codearts-'));
  const dbPath = join(dir, 'opencode.db');
  overrideEnv(t, { CODEARTS_AGENT_DB: dbPath });
  t.after(async () => {
    resetSqliteQueryCache();
    await rm(dir, { recursive: true, force: true });
  });
  writeDb(dbPath, (db) => {
    if (tables.includes('message')) {
      db.exec(
        'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)',
      );
    }
    if (tables.includes('session_message')) {
      db.exec(
        'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT)',
      );
    }
  });
  return { dir, dbPath };
}

function insertLegacy(
  fixture: Fixture,
  id: string,
  sessionId: string,
  data: Record<string, unknown>,
): void {
  writeDb(fixture.dbPath, (db) => {
    db.prepare(
      'INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)',
    ).run(id, sessionId, JSON.stringify(data));
  });
}

function insertV2(
  fixture: Fixture,
  id: string,
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
): void {
  writeDb(fixture.dbPath, (db) => {
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)',
    ).run(id, sessionId, type, JSON.stringify(data));
  });
}

function updateRow(
  fixture: Fixture,
  table: TableName,
  id: string,
  data: Record<string, unknown>,
): void {
  writeDb(fixture.dbPath, (db) => {
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(
      JSON.stringify(data),
      id,
    );
  });
}

function tokensOf(buckets: QueueBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.total_tokens, 0);
}

test('A01 reads the legacy message table and scopes dedup state', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, 'msg-1', 'ses-1', legacyPayload());

  const first = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(first.result.eventsParsed, 1);
  assert.equal(tokensOf(first.result.buckets), 50);
  assert.equal(first.result.buckets[0]!.source, 'codearts-agent');
  assert.equal(first.result.buckets[0]!.collector, 'codearts-agent');

  const again = await parseCodeartsAgentIncremental(first.cursors, SINCE);
  assert.equal(again.result.eventsParsed, 0);
});

test('A02 reads v2 assistant and compaction calls without session totals', async (t) => {
  const fixture = await createFixture(t, ['session_message']);
  insertV2(fixture, 'msg-a', 'ses-1', 'assistant', v2Payload());
  insertV2(fixture, 'msg-c', 'ses-1', 'compaction', v2Payload());

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(result.eventsParsed, 2);
  assert.equal(tokensOf(result.buckets), 100);
});

test('A03 keeps legacy messages when an empty v2 table exists', async (t) => {
  const fixture = await createFixture(t, ['message', 'session_message']);
  insertLegacy(fixture, 'msg-old', 'ses-old', legacyPayload());

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(result.eventsParsed, 1);
  assert.equal(tokensOf(result.buckets), 50);
});

test('A04 sums independent messages from both tables', async (t) => {
  const fixture = await createFixture(t, ['message', 'session_message']);
  insertLegacy(fixture, 'msg-old', 'ses-old', legacyPayload());
  insertV2(fixture, 'msg-new', 'ses-new', 'assistant', v2Payload());

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(result.eventsParsed, 2);
  assert.equal(tokensOf(result.buckets), 100);
});

test('A05 prefers the valid v2 projection for the same message', async (t) => {
  const fixture = await createFixture(t, ['message', 'session_message']);
  insertLegacy(
    fixture,
    'msg-shared',
    'ses-shared',
    legacyPayload({ modelID: 'legacy-model' }),
  );
  insertV2(fixture, 'msg-shared', 'ses-shared', 'assistant', v2Payload({
    tokens: { input: 40, output: 10, reasoning: 3, cache: { read: 5, write: 2 } },
  }));

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(result.eventsParsed, 1);
  assert.equal(tokensOf(result.buckets), 60);
  assert.equal(result.buckets[0]!.model, 'deepseek-r1');
});

test('A06 pending and non-call v2 rows do not hide legacy usage', async (t) => {
  const fixture = await createFixture(t, ['message', 'session_message']);
  insertLegacy(fixture, 'msg-pending', 'ses-1', legacyPayload());
  insertLegacy(fixture, 'msg-noncall', 'ses-1', legacyPayload());
  insertV2(fixture, 'msg-pending', 'ses-1', 'assistant', {
    time: { created: CREATED },
    model: { id: 'deepseek-r1' },
  });
  insertV2(fixture, 'msg-noncall', 'ses-1', 'user', v2Payload());

  const first = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(first.result.eventsParsed, 2);
  assert.equal(tokensOf(first.result.buckets), 100);

  updateRow(
    fixture,
    'session_message',
    'msg-pending',
    v2Payload({ time: { created: CREATED } }),
  );
  const second = await parseCodeartsAgentIncremental(first.cursors, SINCE);
  assert.equal(second.result.eventsParsed, 0);
  assert.equal(tokensOf(second.result.buckets), 0);
});

test('A07 extracts the v2 object model id', async (t) => {
  const fixture = await createFixture(t, ['session_message']);
  insertV2(
    fixture,
    'msg-v2',
    'ses-v2',
    'assistant',
    v2Payload({ model: { id: 'deepseek-r1', providerID: 'huaweicloud' } }),
  );

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(result.eventsParsed, 1);
  assert.equal(result.buckets[0]!.model, 'deepseek-r1');
  assert.ok(!result.buckets[0]!.model.startsWith('{'));
});

test('A08 keeps legacy model field compatibility', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, 'msg-modelid', 'ses-1', legacyPayload({ modelID: 'deepseek-v1' }));
  insertLegacy(fixture, 'msg-string', 'ses-1', legacyPayload({ modelID: undefined, model: 'plain-model' }));
  insertLegacy(fixture, 'msg-camel', 'ses-1', legacyPayload({ modelID: undefined, modelId: 'camel-model' }));
  insertLegacy(
    fixture,
    'msg-unknown',
    'ses-1',
    legacyPayload({
      modelID: undefined,
      path: { root: '/tmp/codearts-no-model' },
    }),
  );

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(result.eventsParsed, 4);
  const models = new Set(result.buckets.map((bucket) => bucket.model));
  assert.ok(models.has('deepseek-v1'));
  assert.ok(models.has('plain-model'));
  assert.ok(models.has('camel-model'));
  assert.ok(models.has('unknown'));
});

test('A09 first stable message records one complete request', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, 'msg-1', 'ses-1', legacyPayload());

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  const bucket = result.buckets[0]!;
  assert.deepEqual(bucket.local_metrics, {
    version: 1,
    requestCount: 1,
    requestCountComplete: true,
    cacheReadComplete: true,
    cacheWriteComplete: true,
    missingReasons: [],
  });
  const metrics = aggregateLocalMetrics(result.buckets);
  assert.equal(metrics.requestCount, 1);
  assert.equal(metrics.knownRequestCount, 1);
  assert.equal(metrics.cacheReadTokens, 5);
  assert.equal(metrics.cacheWriteTokens, 2);
  assert.deepEqual(metrics.missingReasons, []);
});

test('A10 message growth is a zero-request delta and rescan is stable', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, 'msg-1', 'ses-1', legacyPayload());
  const first = await parseCodeartsAgentIncremental({}, SINCE);

  updateRow(fixture, 'message', 'msg-1', legacyPayload({ tokens: baseTokens(14) }));
  const second = await parseCodeartsAgentIncremental(first.cursors, SINCE);
  const delta = second.result.buckets[0]!;
  assert.equal(second.result.eventsParsed, 1);
  assert.equal(delta.total_tokens, 4);
  assert.equal(delta.output_tokens, 4);
  assert.equal(delta.local_metrics?.requestCount, 0);
  assert.equal(delta.local_metrics?.requestCountComplete, true);

  const third = await parseCodeartsAgentIncremental(second.cursors, SINCE);
  assert.equal(third.result.eventsParsed, 0);
});

test('A11 merged evidence keeps totals, requests and cache complete', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, 'msg-1', 'ses-1', legacyPayload());
  const first = await parseCodeartsAgentIncremental({}, SINCE);

  updateRow(fixture, 'message', 'msg-1', legacyPayload({ tokens: baseTokens(14) }));
  const second = await parseCodeartsAgentIncremental(first.cursors, SINCE);

  const merged: QueueBucket = {
    ...first.result.buckets[0]!,
    ...sumTokenTotals(first.result.buckets[0]!, second.result.buckets[0]!),
  };
  assert.equal(merged.total_tokens, 54);
  assert.equal(merged.output_tokens, 14);
  const metrics = metricsFromBucket(merged);
  assert.equal(metrics.requestCount, 1);
  assert.equal(metrics.knownRequestCount, 1);
  assert.equal(metrics.cacheReadTokens, 5);
  assert.equal(metrics.cacheWriteTokens, 2);
  assert.equal(metrics.cacheHitRate, 5 / 37);
  assert.deepEqual(metrics.missingReasons, []);
});

test('A12 independent identical usages count as two requests', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, 'msg-1', 'ses-1', legacyPayload());
  insertLegacy(fixture, 'msg-2', 'ses-1', legacyPayload());

  const { result } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(result.eventsParsed, 2);
  assert.equal(tokensOf(result.buckets), 100);
  const metrics = aggregateLocalMetrics(result.buckets);
  assert.equal(metrics.requestCount, 2);
  assert.equal(metrics.knownRequestCount, 2);
});

test('A13 missing stable ids never claim a complete request count', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, '', '', legacyPayload());

  const { result, cursors } = await parseCodeartsAgentIncremental({}, SINCE);
  assert.equal(tokensOf(result.buckets), 50);
  const local = result.buckets[0]!.local_metrics;
  assert.equal(local?.requestCount, 0);
  assert.equal(local?.requestCountComplete, false);
  const metrics = metricsFromBucket(result.buckets[0]!);
  assert.equal(metrics.requestCount, null);
  assert.equal(metrics.knownRequestCount, 0);
  assert.ok(metrics.missingReasons.includes('ambiguous_request'));
  assert.deepEqual(cursors.codeartsAgent?.messages ?? {}, {});
});

test('A14 real sync accumulates updates and survives a cursor reset', async (t) => {
  const fixture = await createFixture(t, ['message']);
  const home = await mkdtemp(join(tmpdir(), 'jusage-codearts-home-'));
  overrideEnv(t, {
    HOME: home,
    USERPROFILE: home,
    JUSAGE_CONFIG_HOME: join(home, 'config'),
  });
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const dataDir = join(home, 'data');
  const { config } = await loadConfig(dataDir);
  config.statsSince = SINCE;
  config.localCollectSince = SINCE;

  insertLegacy(fixture, 'msg-1', 'ses-1', legacyPayload());
  await syncAll(dataDir, config, 'codearts-agent');
  let buckets = await loadRecentBuckets(dataDir, SINCE);
  assert.equal(tokensOf(buckets), 50);
  assert.equal(aggregateLocalMetrics(buckets).requestCount, 1);
  assert.equal(aggregateLocalMetrics(buckets).cacheReadTokens, 5);
  assert.equal(aggregateLocalMetrics(buckets).cacheWriteTokens, 2);

  updateRow(fixture, 'message', 'msg-1', legacyPayload({ tokens: baseTokens(14) }));
  await syncAll(dataDir, config, 'codearts-agent');
  buckets = await loadRecentBuckets(dataDir, SINCE);
  assert.equal(tokensOf(buckets), 54);
  assert.equal(aggregateLocalMetrics(buckets).outputTokens, 14);
  assert.equal(aggregateLocalMetrics(buckets).requestCount, 1);
  assert.equal(aggregateLocalMetrics(buckets).cacheReadTokens, 5);
  assert.equal(aggregateLocalMetrics(buckets).cacheWriteTokens, 2);

  await syncAll(dataDir, config, 'codearts-agent');
  buckets = await loadRecentBuckets(dataDir, SINCE);
  assert.equal(tokensOf(buckets), 54);
  assert.equal(aggregateLocalMetrics(buckets).requestCount, 1);

  await clearCursors(dataDir);
  await syncAll(dataDir, config, 'codearts-agent');
  buckets = await loadRecentBuckets(dataDir, SINCE);
  assert.equal(tokensOf(buckets), 54);
  assert.equal(aggregateLocalMetrics(buckets).requestCount, 1);
  assert.equal(aggregateLocalMetrics(buckets).cacheReadTokens, 5);
  assert.equal(aggregateLocalMetrics(buckets).cacheWriteTokens, 2);
});

test('A15 an existing cursor is not charged twice on upgrade', async (t) => {
  const fixture = await createFixture(t, ['message']);
  insertLegacy(fixture, 'msg-old', 'ses-old', legacyPayload());
  insertLegacy(fixture, 'msg-new', 'ses-new', legacyPayload());
  const seeded: CursorsFile = {
    codeartsAgent: {
      messages: {
        'ses-old|msg-old': {
          lastTotals: {
            input_tokens: 30,
            output_tokens: 10,
            cached_input_tokens: 5,
            cache_creation_input_tokens: 2,
            reasoning_output_tokens: 3,
            total_tokens: 50,
          },
        },
      },
    },
  };

  const first = await parseCodeartsAgentIncremental(seeded, SINCE);
  assert.equal(first.result.eventsParsed, 1);
  assert.equal(tokensOf(first.result.buckets), 50);
  assert.equal(aggregateLocalMetrics(first.result.buckets).requestCount, 1);

  updateRow(fixture, 'message', 'msg-old', legacyPayload({ tokens: baseTokens(14) }));
  const second = await parseCodeartsAgentIncremental(first.cursors, SINCE);
  assert.equal(second.result.eventsParsed, 1);
  assert.equal(tokensOf(second.result.buckets), 4);
  const delta = second.result.buckets[0]!;
  assert.equal(aggregateLocalMetrics(second.result.buckets).requestCount, 0);
  assert.equal(delta.local_metrics?.requestCount, 0);
  assert.equal(delta.local_metrics?.requestCountComplete, true);
  assert.equal(delta.local_metrics?.cacheReadComplete, true);
  assert.equal(delta.local_metrics?.cacheWriteComplete, true);

  const third = await parseCodeartsAgentIncremental(second.cursors, SINCE);
  assert.equal(third.result.eventsParsed, 0);
});

test('A16 unchanged tokens do not rewrite a historical bucket', async (t) => {
  const fixture = await createFixture(t, ['session_message']);
  insertV2(fixture, 'msg-v2', 'ses-v2', 'assistant', v2Payload());
  const seeded: CursorsFile = {
    codeartsAgent: {
      messages: {
        'ses-v2|msg-v2': {
          lastTotals: {
            input_tokens: 30,
            output_tokens: 10,
            cached_input_tokens: 5,
            cache_creation_input_tokens: 2,
            reasoning_output_tokens: 3,
            total_tokens: 50,
          },
        },
      },
    },
  };

  const { result } = await parseCodeartsAgentIncremental(seeded, SINCE);
  assert.equal(result.eventsParsed, 0);
  assert.equal(result.buckets.length, 0);
});

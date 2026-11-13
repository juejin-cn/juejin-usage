import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  ANTIGRAVITY_COLLECTOR_APP,
  ANTIGRAVITY_COLLECTOR_CLI,
  ANTIGRAVITY_COLLECTOR_IDE,
  antigravityCollectorForPath,
  estimateAntigravityTokens,
  listAntigravitySessionFiles,
  listAntigravityTranscripts,
  parseAntigravityIncremental,
  parseAntigravityModelSelection,
} from '../src/parsers/antigravity.js';
import { appendBuckets, loadRecentBuckets, loadCursors, saveCursors } from '../src/queue/index.js';
import { syncAntigravity } from '../src/sync/index.js';
import type { TudConfig } from '../src/types.js';
import { bucketToIngestEvent } from '../src/upload/events.js';

const SINCE = '2020-01-01T00:00:00.000Z';

async function writeTranscript(
  home: string,
  variant: 'antigravity' | 'antigravity-ide' | 'antigravity-cli',
  sessionId: string,
  lines: unknown[],
  settingsModel?: string,
): Promise<string> {
  const logsDir = join(
    home,
    variant,
    'brain',
    sessionId,
    '.system_generated',
    'logs',
  );
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = join(logsDir, 'transcript.jsonl');
  await writeFile(
    transcriptPath,
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  if (settingsModel) {
    await writeFile(
      join(home, variant, 'settings.json'),
      JSON.stringify({ model: settingsModel }),
    );
  }
  return transcriptPath;
}

test('antigravityCollectorForPath tags cli / ide / app', () => {
  assert.equal(
    antigravityCollectorForPath('/Users/x/.gemini/antigravity-cli/brain/s/logs/t.jsonl'),
    ANTIGRAVITY_COLLECTOR_CLI,
  );
  assert.equal(
    antigravityCollectorForPath('/Users/x/.gemini/antigravity-ide/brain/s/logs/t.jsonl'),
    ANTIGRAVITY_COLLECTOR_IDE,
  );
  assert.equal(
    antigravityCollectorForPath('/Users/x/.gemini/antigravity/brain/s/logs/t.jsonl'),
    ANTIGRAVITY_COLLECTOR_APP,
  );
});

test('listAntigravityTranscripts discovers cli + ide + legacy brains', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-agy-discover-'));
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    const legacy = await writeTranscript(home, 'antigravity', 'session-legacy', []);
    const ide = await writeTranscript(home, 'antigravity-ide', 'session-ide', []);
    const cli = await writeTranscript(home, 'antigravity-cli', 'session-cli', []);
    const all = listAntigravityTranscripts(home).sort();
    assert.deepEqual(all, [cli, ide, legacy].sort());
    assert.deepEqual(listAntigravitySessionFiles(join(home, 'missing', 'brain')), []);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
  }
});

test('parseAntigravityModelSelection normalizes Gemini Flash', () => {
  const model = parseAntigravityModelSelection(
    'changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n',
  );
  assert.equal(model, 'gemini-3.5-flash');
});

test('parseAntigravityIncremental bills delta context for CLI + IDE collectors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-agy-parse-'));
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    const modelSelection =
      'changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n';
    const userA = 'u'.repeat(40);
    const toolResult = 'r'.repeat(80);
    const answerA = 'a'.repeat(20);
    const thinkingA = 't'.repeat(12);
    const userB = 'b'.repeat(40);
    const answerB = 'c'.repeat(20);
    const thinkingB = 'd'.repeat(12);

    const sharedLines = [
      {
        type: 'USER_INPUT',
        created_at: '2026-04-05T14:00:00.000Z',
        content: modelSelection + userA,
      },
      { type: 'TOOL_RESULT', created_at: '2026-04-05T14:01:00.000Z', content: toolResult },
      {
        type: 'PLANNER_RESPONSE',
        created_at: '2026-04-05T14:02:00.000Z',
        content: answerA,
        thinking: thinkingA,
      },
      { type: 'USER_INPUT', created_at: '2026-04-05T14:03:00.000Z', content: userB },
      {
        type: 'PLANNER_RESPONSE',
        created_at: '2026-04-05T14:04:00.000Z',
        content: answerB,
        thinking: thinkingB,
      },
    ];

    await writeTranscript(home, 'antigravity-cli', 'sess-cli', sharedLines);
    await writeTranscript(home, 'antigravity-ide', 'sess-ide', sharedLines);

    const { result, cursors } = await parseAntigravityIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 4); // 2 planners × 2 variants
    assert.equal(result.buckets.length, 2);

    const byCollector = new Map(result.buckets.map((b) => [b.collector, b]));
    assert.ok(byCollector.has(ANTIGRAVITY_COLLECTOR_CLI));
    assert.ok(byCollector.has(ANTIGRAVITY_COLLECTOR_IDE));

    const cli = byCollector.get(ANTIGRAVITY_COLLECTOR_CLI)!;
    assert.equal(cli.source, 'antigravity');
    assert.equal(cli.model, 'gemini-3.5-flash');
    const firstInput =
      estimateAntigravityTokens(modelSelection + userA) +
      estimateAntigravityTokens(toolResult);
    const secondInput =
      estimateAntigravityTokens(answerA) + estimateAntigravityTokens(userB);
    assert.equal(cli.input_tokens, firstInput + secondInput);
    assert.equal(cli.output_tokens, 10);
    assert.equal(cli.reasoning_output_tokens, 6);
    assert.equal(cli.conversation_count, 2);
    assert.equal(
      cli.total_tokens,
      cli.input_tokens + cli.output_tokens + cli.reasoning_output_tokens,
    );

    // Unchanged → no new events
    const again = await parseAntigravityIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
  }
});

test('parseAntigravityIncremental replaces the session after append (trailing newline safe)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-agy-append-'));
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    const firstLine = {
      type: 'USER_INPUT',
      created_at: '2026-04-05T14:00:00.000Z',
      content:
        'changed setting `Model Selection` from Auto to Gemini 3.5 Flash.\n' +
        'u'.repeat(40),
    };
    const transcriptPath = await writeTranscript(
      home,
      'antigravity-cli',
      'sess-append',
      [firstLine],
    );

    const first = await parseAntigravityIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 0);
    assert.equal(first.cursors.antigravity?.files[transcriptPath]?.lastLine, 1);

    const plannerLine = {
      type: 'PLANNER_RESPONSE',
      created_at: '2026-04-05T14:02:00.000Z',
      content: 'a'.repeat(20),
    };
    await writeFile(
      transcriptPath,
      `${JSON.stringify(firstLine)}\n${JSON.stringify(plannerLine)}\n`,
    );

    const second = await parseAntigravityIncremental(first.cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]!.collector, ANTIGRAVITY_COLLECTOR_CLI);
    assert.equal(second.result.buckets[0]!.model, 'gemini-3.5-flash');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
  }
});

test('bucketToIngestEvent maps antigravity with collector', () => {
  const deviceId = '550e8400-e29b-41d4-a716-446655440000';
  const event = bucketToIngestEvent(
    {
      hour_start: '2026-04-05T14:00:00.000Z',
      source: 'antigravity',
      model: 'gemini-3.5-flash',
      collector: ANTIGRAVITY_COLLECTOR_IDE,
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 15,
      conversation_count: 1,
    },
    deviceId,
  );
  assert.equal(event?.integration, 'antigravity');
  assert.equal(event?.collector, ANTIGRAVITY_COLLECTOR_IDE);
});


function nativeStep(step: number, overrides: Record<string, unknown> = {}) {
  return {
    step_index: step,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-04-05T14:02:00.000Z',
    input_tokens: 80,
    cache_read_tokens: 20,
    cache_write_tokens: 3,
    output_tokens: 12,
    content: 'short',
    thinking: 'must not be added again',
    ...overrides,
  };
}

async function writeNative(home: string, session: string, lines: unknown[]) {
  const legacy = await writeTranscript(home, 'antigravity-cli', session, []);
  const full = join(dirname(legacy), 'transcript_full.jsonl');
  await writeFile(full, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return full;
}

test('native export uses exact counters, latest step and historical model, not current settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-agy-native-'));
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    const full = await writeNative(home, 'native', [
      nativeStep(2, { input_tokens: 1 }),
      { step_index: 0, type: 'USER_INPUT', content: 'changed setting `Model Selection` from None to Gemini 3.5 Flash.' },
      nativeStep(1, { status: 'RUNNING', input_tokens: 999 }),
      nativeStep(2),
      nativeStep(2, { status: 'RUNNING', input_tokens: 10000 }),
      nativeStep(3, { status: 'ERROR' }),
      nativeStep(4, { type: 'CHECKPOINT' }),
      nativeStep(5, { model: 'Claude Sonnet 4.6', input_tokens: 4 }),
      nativeStep(6, { input_tokens: -1 }),
      nativeStep(7, { input_tokens: '100' }),
      nativeStep(8, { input_tokens: Number.MAX_SAFE_INTEGER }),
    ]);
    await writeFile(join(home, 'antigravity-cli', 'settings.json'), JSON.stringify({ model: 'wrong-current-model' }));
    // The simplified export overlaps the same session and must never be added.
    await writeTranscript(home, 'antigravity-cli', 'native', [
      { type: 'USER_INPUT', created_at: '2026-04-05T14:00:00Z', content: 'x'.repeat(4000) },
      { type: 'PLANNER_RESPONSE', created_at: '2026-04-05T14:00:01Z', content: 'y'.repeat(4000) },
    ]);
    assert.deepEqual(listAntigravityTranscripts(home), [full]);
    const { result, cursors } = await parseAntigravityIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 2);
    const gemini = result.buckets.find((b) => b.model === 'gemini-3.5-flash')!;
    assert.equal(gemini.input_tokens, 80);
    assert.equal(gemini.cached_input_tokens, 20);
    assert.equal(gemini.cache_creation_input_tokens, 3);
    assert.equal(gemini.output_tokens, 12);
    assert.equal(gemini.reasoning_output_tokens, 0);
    assert.equal(gemini.total_tokens, 115);
    assert.equal(result.buckets.find((b) => b.model === 'claude-sonnet-4.6')?.input_tokens, 4);
    assert.equal((await parseAntigravityIncremental(cursors, SINCE)).result.buckets.length, 0);
    assert.equal((await parseAntigravityIncremental({}, '2026-04-06T00:00:00Z')).result.buckets.length, 0);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test('sync replaces legacy estimates, upgrades old cursors and corrects rewritten native steps', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-agy-migrate-'));
  const dataDir = join(home, 'data');
  await mkdir(dataDir);
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  const config = {
    dataDir,
    statsSince: SINCE,
    localCollectSince: SINCE,
    deviceId: 'test',
    hostname: 'test',
    juejin: { enabled: false, apiUrl: '', authMode: 'device', token: null },
  } as TudConfig;
  try {
    const legacy = await writeTranscript(home, 'antigravity-cli', 'migration', [
      { type: 'USER_INPUT', created_at: '2026-04-05T14:00:00Z', content: 'x'.repeat(400) },
      { type: 'PLANNER_RESPONSE', created_at: '2026-04-05T14:00:01Z', content: 'y'.repeat(400) },
    ], 'old-model');
    const estimated = await parseAntigravityIncremental({}, SINCE);
    const unrelated = { ...estimated.result.buckets[0]!, source: 'codex', project: 'unrelated' };
    const missingSession = { ...estimated.result.buckets[0]!, project: 'missing-session' };
    await appendBuckets(dataDir, [...estimated.result.buckets, unrelated, missingSession]);
    const readSession = async () => (await loadRecentBuckets(dataDir, SINCE)).filter((b) => b.source === 'antigravity' && b.project === 'migration');
    const legacyCursor = estimated.cursors.antigravity!.files[legacy]!;
    delete legacyCursor.snapshotVersion;
    await saveCursors(dataDir, estimated.cursors);
    // Old matching inode/size/mtime cannot bypass the migration.
    assert.equal((await syncAntigravity(dataDir, config)).eventsParsed, 1);
    assert.equal((await loadCursors(dataDir)).antigravity!.files[legacy]!.snapshotVersion, 1);
    const full = join(dirname(legacy), 'transcript_full.jsonl');
    await writeFile(full, '{"unfinished');
    assert.equal((await syncAntigravity(dataDir, config)).bucketsWritten, 0);
    assert.ok((await loadCursors(dataDir)).antigravity!.files[legacy]);
    await writeFile(full, JSON.stringify(nativeStep(1, { model: 'Gemini 3.5 Flash' })) + '\n');
    await syncAntigravity(dataDir, config);
    assert.equal((await loadCursors(dataDir)).antigravity!.files[legacy], undefined);
    let rows = await readSession();
    assert.equal(rows.reduce((sum, b) => sum + b.total_tokens, 0), 115);
    assert.equal(rows.find((b) => b.model === 'antigravity-old-model')?.total_tokens, 0);
    assert.equal((await syncAntigravity(dataDir, config)).bucketsWritten, 0);
    // Losing the native export temporarily must not reinstate legacy estimates.
    const offline = join(dirname(full), 'transcript_full.offline');
    await rename(full, offline);
    assert.equal((await syncAntigravity(dataDir, config)).bucketsWritten, 0);
    assert.equal((await readSession()).reduce((sum, row) => sum + row.total_tokens, 0), 115);
    await rename(offline, full);
    assert.equal((await syncAntigravity(dataDir, config)).bucketsWritten, 0);
    assert.equal((await readSession()).reduce((sum, row) => sum + row.total_tokens, 0), 115);
    // Completed counters can be rewritten downward; they replace the prior bucket.
    await writeFile(full, JSON.stringify(nativeStep(1, { model: 'Claude Sonnet 4.6', input_tokens: 5 })) + '\n');
    await syncAntigravity(dataDir, config);
    rows = await readSession();
    assert.equal(rows.reduce((sum, b) => sum + b.total_tokens, 0), 40);
    assert.equal(rows.find((b) => b.model === 'gemini-3.5-flash')?.total_tokens, 0);
    // An in-progress rewrite cannot erase the last complete snapshot.
    for (const raw of ['', JSON.stringify(nativeStep(1)) + '\n{"step_index":2']) {
      await writeFile(full, raw);
      assert.equal((await syncAntigravity(dataDir, config)).bucketsWritten, 0);
      assert.equal((await readSession()).reduce((sum, b) => sum + b.total_tokens, 0), 40);
    }
    const running = nativeStep(2, { status: 'RUNNING', model: 'Gemini 3.5 Flash' });
    await writeFile(full, JSON.stringify(running) + '\n');
    await syncAntigravity(dataDir, config);
    await writeFile(full, JSON.stringify({ ...running, status: 'DONE' }) + '\n');
    await syncAntigravity(dataDir, config);
    assert.equal((await readSession()).reduce((sum, b) => sum + b.total_tokens, 0), 155);
    // Restoring an older completed step cannot double count it.
    const completed = nativeStep(1, { model: 'Claude Sonnet 4.6', input_tokens: 5 });
    await writeFile(full, [completed, { ...running, status: 'DONE' }]
      .map((row) => JSON.stringify(row)).join('\n') + '\n');
    assert.equal((await syncAntigravity(dataDir, config)).bucketsWritten, 0);
    // A corrected timestamp retracts the old month and writes the new one.
    await writeFile(full, [
      { ...completed, created_at: '2026-05-05T14:02:00Z' },
      { ...running, status: 'DONE' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await syncAntigravity(dataDir, config);
    assert.equal((await readSession()).reduce((sum, b) => sum + b.total_tokens, 0), 155);
    assert.deepEqual((await loadCursors(dataDir)).antigravity!.files[full]!.snapshotMonths?.sort(), ['2026-04', '2026-05']);
    const allRows = await loadRecentBuckets(dataDir, SINCE);
    assert.deepEqual(allRows.find((b) => b.source === 'codex'), unrelated);
    assert.deepEqual(allRows.find((b) => b.project === 'missing-session'), missingSession);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

for (const format of ['native', 'legacy'] as const) {
  test(`${format} export skips a damaged middle line but retries an incomplete final line`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'tud-agy-damaged-'));
    const prev = process.env.GEMINI_HOME;
    process.env.GEMINI_HOME = home;
    try {
      const records = format === 'native'
        ? [nativeStep(1), nativeStep(2)]
        : [
            { type: 'USER_INPUT', created_at: '2026-04-05T14:00:00Z', content: 'question' },
            { type: 'PLANNER_RESPONSE', created_at: '2026-04-05T14:02:00Z', content: 'answer' },
          ];
      const file = format === 'native'
        ? await writeNative(home, 'damaged', records)
        : await writeTranscript(home, 'antigravity-cli', 'damaged', records);
      const lines = records.map((record) => JSON.stringify(record));
      await writeFile(file, `${lines[0]}\n{"broken\n${lines[1]}\n`);

      const first = await parseAntigravityIncremental({}, SINCE);
      assert.equal(first.result.eventsParsed, format === 'native' ? 2 : 1);
      assert.equal(first.result.replacedSessions.length, 1);
      const savedCursor = structuredClone(first.cursors);

      await writeFile(file, `${lines[0]}\n{"broken\n${lines[1]}\n{"unfinished\n\n`);
      const incomplete = await parseAntigravityIncremental(first.cursors, SINCE);
      assert.equal(incomplete.result.buckets.length, 0);
      assert.deepEqual(incomplete.result.replacedSessions, []);
      assert.deepEqual(incomplete.cursors, savedCursor);

      // Once a valid later line exists, the broken line is no longer a tail.
      await writeFile(file, `${lines[0]}\n{"broken\n${lines[1]}\n{"unfinished\n{}\n`);
      const repairedTail = await parseAntigravityIncremental(incomplete.cursors, SINCE);
      assert.deepEqual(repairedTail.result.buckets, first.result.buckets);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = prev;
      await rm(home, { recursive: true, force: true });
    }
  });
}

test('native cursors compact older bucket records and prune steps outside the window even when unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-agy-cursor-'));
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    const full = await writeNative(home, 'cursor', [
      nativeStep(1),
      nativeStep(2, { created_at: '2026-05-05T14:02:00Z' }),
    ]);
    const first = await parseAntigravityIncremental({}, SINCE);
    const cursor = first.cursors.antigravity!.files[full]!;
    // Simulate the old persisted shape, which retained entire queue buckets.
    cursor.nativeSteps = Object.fromEntries(first.result.buckets.map((bucket, index) => [index + 1, bucket]));
    const legacy = join(dirname(full), 'transcript.jsonl');
    first.cursors.antigravity!.files[legacy] = { ...cursor };
    const missing = join(home, 'missing-session', 'transcript_full.jsonl');
    first.cursors.antigravity!.files[missing] = structuredClone(cursor);
    const ownedMonths = [...cursor.snapshotMonths!];
    await saveCursors(home, first.cursors);

    const unchanged = await parseAntigravityIncremental(await loadCursors(home), '2026-05-01T00:00:00Z');
    assert.equal(unchanged.result.buckets.length, 0);
    const compact = unchanged.cursors.antigravity!.files[full]!;
    assert.deepEqual(Object.keys(compact.nativeSteps!), ['2']);
    assert.deepEqual(Object.keys(unchanged.cursors.antigravity!.files[missing]!.nativeSteps!), ['2']);
    assert.deepEqual(Object.keys(compact.nativeSteps!['2']!).sort(), [
      'cache_creation_input_tokens', 'cached_input_tokens', 'hour_start',
      'input_tokens', 'model', 'output_tokens',
    ]);
    assert.deepEqual(compact.snapshotMonths, ownedMonths);
    assert.equal(unchanged.cursors.antigravity!.files[legacy], undefined);

    // A rewrite that omits the completed step still uses the compact snapshot.
    await writeFile(full, JSON.stringify(nativeStep(3, { status: 'RUNNING' })) + '\n');
    const rewritten = await parseAntigravityIncremental(unchanged.cursors, '2026-05-01T00:00:00Z');
    assert.equal(rewritten.result.buckets[0]!.total_tokens, 115);
    assert.equal(rewritten.result.buckets[0]!.conversation_count, 1);
    assert.deepEqual(rewritten.result.replacedSessions[0]!.months?.sort(), ['2026-04', '2026-05']);

    // A valid correction can move a previously completed step outside the floor.
    await writeFile(full, JSON.stringify(nativeStep(2)) + '\n');
    const outside = await parseAntigravityIncremental(rewritten.cursors, '2026-05-01T00:00:00Z');
    assert.deepEqual(outside.result.buckets, []);
    assert.deepEqual(outside.cursors.antigravity!.files[full]!.nativeSteps, {});
    assert.deepEqual(outside.result.replacedSessions[0]!.months, ['2026-05']);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

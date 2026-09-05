import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  diffGeminiTotals,
  normalizeGeminiTokens,
  parseGeminiIncremental,
} from '../src/parsers/gemini.js';
import {
  deriveOpencodeMessageKey,
  normalizeOpencodeTokens,
  parseOpencodeIncremental,
} from '../src/parsers/opencode.js';
import { parseCopilotIncremental } from '../src/parsers/copilot.js';
import { bucketToIngestEvent } from '../src/upload/events.js';
import type { QueueBucket } from '../src/types.js';

const SINCE = '2020-01-01T00:00:00.000Z';

test('normalizeGeminiTokens folds tool into output and keeps cache separate', () => {
  const t = normalizeGeminiTokens({
    input: 10,
    output: 1,
    cached: 2,
    thoughts: 3,
    tool: 1,
    total: 14,
  });
  assert.ok(t);
  assert.equal(t!.input_tokens, 10);
  assert.equal(t!.cached_input_tokens, 2);
  assert.equal(t!.output_tokens, 2);
  assert.equal(t!.reasoning_output_tokens, 3);
  assert.equal(t!.total_tokens, 17); // max(14, 10+2+1+1+3)
});

test('diffGeminiTotals skips duplicate cumulative snapshots', () => {
  const snap = normalizeGeminiTokens({
    input: 5,
    output: 1,
    cached: 0,
    thoughts: 0,
    tool: 0,
    total: 6,
  })!;
  assert.equal(diffGeminiTotals(snap, snap), null);
  const next = normalizeGeminiTokens({
    input: 8,
    output: 2,
    cached: 0,
    thoughts: 0,
    tool: 0,
    total: 10,
  })!;
  const delta = diffGeminiTotals(next, snap)!;
  assert.equal(delta.input_tokens, 3);
  assert.equal(delta.output_tokens, 1);
  assert.equal(delta.total_tokens, 4);
});

test('parseGeminiIncremental aggregates cumulative session tokens', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-gemini-'));
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    const chats = join(home, 'tmp', 'projhash', 'chats');
    await mkdir(chats, { recursive: true });
    const session = {
      directories: ['/Users/me/my-app'],
      messages: [
        {
          id: 'm1',
          type: 'gemini',
          timestamp: '2026-07-20T08:05:00.000Z',
          model: 'gemini-2.5-pro',
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
        {
          id: 'm2',
          type: 'gemini',
          timestamp: '2026-07-20T08:10:00.000Z',
          model: 'gemini-2.5-pro',
          tokens: { input: 5, output: 1, cached: 0, thoughts: 0, tool: 0, total: 6 },
        },
        {
          id: 'm3',
          type: 'gemini',
          timestamp: '2026-07-20T08:15:00.000Z',
          model: 'gemini-2.5-pro',
          tokens: { input: 8, output: 2, cached: 0, thoughts: 0, tool: 0, total: 10 },
        },
      ],
    };
    await writeFile(join(chats, 'session-1.json'), JSON.stringify(session));

    const { result, cursors } = await parseGeminiIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 2);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]!.source, 'gemini');
    assert.equal(result.buckets[0]!.model, 'gemini-2.5-pro');
    assert.equal(result.buckets[0]!.project, 'my-app');
    assert.equal(result.buckets[0]!.input_tokens, 8);
    assert.equal(result.buckets[0]!.output_tokens, 2);
    assert.equal(result.buckets[0]!.total_tokens, 10);
    assert.equal(result.buckets[0]!.collector, 'gemini-cli');
    assert.ok(Object.keys(cursors.gemini?.files ?? {}).length >= 1);

    // Second pass: unchanged file → no new events
    const again = await parseGeminiIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
    assert.equal(again.result.buckets.length, 0);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
  }
});

test('parseGeminiIncremental reads jsonl sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-gemini-jsonl-'));
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    const chats = join(home, 'tmp', 'hash2', 'chats');
    await mkdir(chats, { recursive: true });
    const lines = [
      JSON.stringify({ directories: ['/tmp/demo'] }),
      JSON.stringify({
        type: 'gemini',
        timestamp: '2026-07-21T10:05:00.000Z',
        model: 'gemini-flash',
        tokens: { input: 3, output: 1, cached: 1, thoughts: 0, tool: 0, total: 5 },
      }),
    ];
    await writeFile(join(chats, 'session-2.jsonl'), lines.join('\n'));

    const { result } = await parseGeminiIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.cached_input_tokens, 1);
    assert.equal(result.buckets[0]!.project, 'demo');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
  }
});

test('normalizeOpencodeTokens includes cache.write', () => {
  const t = normalizeOpencodeTokens({
    input: 10,
    output: 5,
    reasoning: 2,
    cache: { read: 3, write: 4 },
  });
  assert.ok(t);
  assert.equal(t!.cached_input_tokens, 3);
  assert.equal(t!.cache_creation_input_tokens, 4);
  assert.equal(t!.total_tokens, 24);
  assert.equal(deriveOpencodeMessageKey('ses_1', 'msg_1'), 'ses_1|msg_1');
});

test('parseOpencodeIncremental reads sqlite and is rewrite-safe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-opencode-'));
  const prev = process.env.OPENCODE_HOME;
  process.env.OPENCODE_HOME = home;
  try {
    await mkdir(home, { recursive: true });
    const dbPath = join(home, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT
    )`);
    const payload = {
      role: 'assistant',
      time: { created: Date.parse('2026-07-22T12:05:00.000Z') },
      modelID: 'claude-sonnet-4',
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
      path: { root: '/Users/me/opencode-app' },
    };
    db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)').run(
      'msg_a',
      'ses_a',
      JSON.stringify(payload),
    );
    db.close();

    const first = await parseOpencodeIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    assert.equal(first.result.buckets[0]!.source, 'opencode');
    assert.equal(first.result.buckets[0]!.input_tokens, 100);
    assert.equal(first.result.buckets[0]!.cache_creation_input_tokens, 5);
    assert.equal(first.result.buckets[0]!.project, 'opencode-app');

    // Rewrite same totals → no new delta
    const second = await parseOpencodeIncremental(first.cursors, SINCE);
    assert.equal(second.result.eventsParsed, 0);

    // Increase totals → only delta
    const db2 = new DatabaseSync(dbPath);
    const bumped = {
      ...payload,
      tokens: { input: 150, output: 70, reasoning: 0, cache: { read: 10, write: 5 } },
    };
    db2.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(bumped), 'msg_a');
    db2.close();

    const third = await parseOpencodeIncremental(second.cursors, SINCE);
    assert.equal(third.result.eventsParsed, 1);
    assert.equal(third.result.buckets[0]!.input_tokens, 50);
    assert.equal(third.result.buckets[0]!.output_tokens, 20);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
  }
});

test('parseCopilotIncremental reads session.shutdown modelMetrics', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-copilot-'));
  const prev = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const sessionDir = join(home, 'session-state', 'sess-1');
    await mkdir(sessionDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2026-07-23T09:00:00.000Z',
        data: { context: { cwd: '/Users/me/copilot-demo' } },
      }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: '2026-07-23T09:30:00.000Z',
        data: {
          modelMetrics: {
            'gpt-4.1': {
              usage: {
                inputTokens: 120,
                cacheReadTokens: 20,
                cacheWriteTokens: 5,
                outputTokens: 40,
              },
            },
          },
        },
      }),
    ];
    await writeFile(join(sessionDir, 'events.jsonl'), lines.join('\n'));

    const { result, cursors } = await parseCopilotIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.source, 'copilot');
    assert.equal(result.buckets[0]!.model, 'gpt-4.1');
    assert.equal(result.buckets[0]!.project, 'copilot-demo');
    assert.equal(result.buckets[0]!.input_tokens, 100);
    assert.equal(result.buckets[0]!.cached_input_tokens, 20);
    assert.equal(result.buckets[0]!.cache_creation_input_tokens, 5);
    assert.equal(result.buckets[0]!.output_tokens, 40);
    assert.equal(result.buckets[0]!.collector, 'copilot-cli');

    const again = await parseCopilotIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
  } finally {
    if (prev === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prev;
  }
});

test('parseCopilotIncremental keeps the project across incremental reads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tud-copilot-'));
  const prev = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const sessionDir = join(home, 'session-state', 'sess-2');
    await mkdir(sessionDir, { recursive: true });
    const eventsFile = join(sessionDir, 'events.jsonl');
    const startLine = JSON.stringify({
      type: 'session.start',
      timestamp: '2026-07-23T09:00:00.000Z',
      data: { context: { cwd: '/Users/me/copilot-demo' } },
    });
    const shutdownLine = JSON.stringify({
      type: 'session.shutdown',
      timestamp: '2026-07-23T09:30:00.000Z',
      data: {
        modelMetrics: {
          'gpt-4.1': { usage: { inputTokens: 120, outputTokens: 40 } },
        },
      },
    });

    // Scan 1 sees only session.start (session still running).
    await writeFile(eventsFile, `${startLine}\n`);
    const first = await parseCopilotIncremental({}, SINCE);
    assert.equal(first.result.eventsParsed, 0);

    // Scan 2 resumes from the byte cursor and only sees the shutdown line;
    // the project from scan 1 must survive instead of falling to 'unknown'.
    await appendFile(eventsFile, `${shutdownLine}\n`);
    const second = await parseCopilotIncremental(first.cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets[0]!.project, 'copilot-demo');

    // Convergence: the incremental result must match a fresh full scan, so a
    // cursor-clearing rescan replaces the same bucket key instead of adding
    // a second row under another project.
    const full = await parseCopilotIncremental({}, SINCE);
    assert.equal(full.result.buckets[0]!.project, 'copilot-demo');
    assert.deepEqual(
      { ...second.result.buckets[0]! },
      { ...full.result.buckets[0]! },
    );
  } finally {
    if (prev === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prev;
  }
});

test('bucketToIngestEvent maps gemini/opencode/copilot', () => {
  const deviceId = '550e8400-e29b-41d4-a716-446655440000';
  const rows: QueueBucket[] = [
    {
      hour_start: '2026-07-20T08:00:00.000Z',
      source: 'gemini',
      model: 'gemini-2.5-pro',
      project: 'x',
      collector: 'gemini-cli',
      input_tokens: 1,
      output_tokens: 1,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 2,
      conversation_count: 1,
    },
    {
      hour_start: '2026-07-20T08:00:00.000Z',
      source: 'opencode',
      model: 'claude-sonnet-4',
      project: 'x',
      input_tokens: 1,
      output_tokens: 1,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 2,
      conversation_count: 1,
    },
    {
      hour_start: '2026-07-20T08:00:00.000Z',
      source: 'copilot',
      model: 'gpt-4.1',
      project: 'x',
      input_tokens: 1,
      output_tokens: 1,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 2,
      conversation_count: 1,
    },
  ];
  const integrations = rows.map((r) => bucketToIngestEvent(r, deviceId)?.integration);
  assert.deepEqual(integrations, ['gemini', 'opencode', 'copilot']);
  assert.equal(bucketToIngestEvent(rows[1]!, deviceId)?.collector, 'opencode');
});

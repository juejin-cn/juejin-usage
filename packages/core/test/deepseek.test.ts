import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { parseDeepseekIncremental } from '../src/parsers/deepseek.js';
import type { CursorsFile } from '../src/types.js';

const SINCE = '2026-01-01T00:00:00.000Z';

/** Realistic DSH session events for one step (usage chunk + paired message). */
function dshStepLines(
  seq: number,
  timeMs: number,
  model: string,
  usage: Record<string, number>,
): string[] {
  return [
    JSON.stringify({ type: 'session', version: 0, id: 'session-x', createdAt: timeMs, cwd: '/repo/demo-app' }),
    JSON.stringify({ type: 'request/context', seq, time: timeMs, data: { provider: 'deepseek-official', model } }),
    JSON.stringify({ type: 'assistant/chunk', seq: seq + 1, time: timeMs + 100, data: { turn: 1, step: 1, chunk: { type: 'usage', usage } } }),
    JSON.stringify({ type: 'assistant/message', seq: seq + 2, time: timeMs + 100, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model } }, usage } }),
  ];
}

async function withDshHome(tempHome: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(tempHome, '.dsh');
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

test('parseDeepseekIncremental parses usage chunks once (not the paired message)', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-dsh-'));
  const sessionsDir = join(tempHome, '.dsh', 'sessions', 'repo-demo-app', 'session-x');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'session.jsonl');
  const timeMs = new Date('2026-07-24T12:05:00.000Z').getTime();
  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, reasoningTokens: 10 };
  await writeFile(filePath, `${dshStepLines(1, timeMs, 'deepseek-v4-flash', usage).join('\n')}\n`, 'utf8');

  await withDshHome(tempHome, async () => {
    const { result } = await parseDeepseekIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.buckets.length, 1);
    const b = result.buckets[0]!;
    assert.equal(b.source, 'deepseek');
    assert.equal(b.collector, 'deepseek-harness');
    assert.equal(b.model, 'deepseek-v4-flash');
    assert.equal(b.project, 'demo-app');
    assert.equal(b.input_tokens, 100);
    assert.equal(b.output_tokens, 50);
    assert.equal(b.cached_input_tokens, 20);
    assert.equal(b.reasoning_output_tokens, 10);
    assert.equal(b.total_tokens, 180);
    assert.equal(b.conversation_count, 1);
  });
});

test('parseDeepseekIncremental is incremental and does not double count on growth', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-dsh-'));
  const sessionsDir = join(tempHome, '.dsh', 'sessions', 'repo-demo-app', 'session-x');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'session.jsonl');
  const t1 = new Date('2026-07-24T12:05:00.000Z').getTime();
  const t2 = new Date('2026-07-24T12:35:00.000Z').getTime();

  await withDshHome(tempHome, async () => {
    const cursors: CursorsFile = {};
    await writeFile(
      filePath,
      `${dshStepLines(1, t1, 'deepseek-v4-flash', { inputTokens: 100, outputTokens: 50 }).join('\n')}\n`,
      'utf8',
    );
    const first = await parseDeepseekIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    assert.equal(first.result.buckets[0]?.total_tokens, 150);

    // File grows with a second step in the next half-hour bucket.
    await writeFile(
      filePath,
      `${dshStepLines(5, t2, 'deepseek-v4-flash', { inputTokens: 30, outputTokens: 20 }).join('\n')}\n`,
      'utf8',
    );
    const second = await parseDeepseekIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets.length, 1);
    assert.equal(second.result.buckets[0]?.total_tokens, 50);

    // Unchanged file → nothing new.
    const third = await parseDeepseekIncremental(cursors, SINCE);
    assert.equal(third.result.eventsParsed, 0);
    assert.equal(third.result.buckets.length, 0);
  });
});

test('parseDeepseekIncremental supports legacy assistant/tokens events', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-dsh-'));
  const sessionsDir = join(tempHome, '.dsh', 'sessions', 'repo-demo-app', 'session-x');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'session.jsonl');
  const legacy = JSON.stringify({
    type: 'assistant',
    seq: 3,
    ts: '2026-07-24T13:05:00.000Z',
    model: 'deepseek-chat',
    tokens: { input: 10, output: 5, cache_read: 2, cache_creation: 1, reasoning: 0 },
  });
  await writeFile(filePath, `${legacy}\n`, 'utf8');

  await withDshHome(tempHome, async () => {
    const { result } = await parseDeepseekIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 1);
    const b = result.buckets[0]!;
    assert.equal(b.model, 'deepseek-chat');
    assert.equal(b.input_tokens, 10);
    assert.equal(b.output_tokens, 5);
    assert.equal(b.cached_input_tokens, 2);
    assert.equal(b.cache_creation_input_tokens, 1);
    assert.equal(b.total_tokens, 18);
  });
});

test('parseDeepseekIncremental reads multi-frame zstd session files', async (t) => {
  if (typeof zstdCompressSync !== 'function') {
    t.skip('zstdCompressSync unavailable (Node >= 22.9 required)');
    return;
  }
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-dsh-'));
  const sessionsDir = join(tempHome, '.dsh', 'sessions', 'repo-demo-app', 'session-x');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'session.jsonl.zstd');
  const t1 = new Date('2026-07-24T12:05:00.000Z').getTime();
  const t2 = new Date('2026-07-24T12:35:00.000Z').getTime();
  const frame1 = zstdCompressSync(Buffer.from(`${dshStepLines(1, t1, 'deepseek-v4-flash', { inputTokens: 10, outputTokens: 5 }).join('\n')}\n`));
  const frame2 = zstdCompressSync(Buffer.from(`${dshStepLines(5, t2, 'deepseek-v4-flash', { inputTokens: 3, outputTokens: 2 }).join('\n')}\n`));
  await writeFile(filePath, Buffer.concat([frame1, frame2]));

  await withDshHome(tempHome, async () => {
    const { result } = await parseDeepseekIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 2);
    const total = result.buckets.reduce((sum, b) => sum + b.total_tokens, 0);
    assert.equal(total, 20);
  });
});

test('parseDeepseekIncremental skips events before statsSince', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'tud-dsh-'));
  const sessionsDir = join(tempHome, '.dsh', 'sessions', 'repo-demo-app', 'session-x');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, 'session.jsonl');
  const oldTime = new Date('2025-06-01T12:05:00.000Z').getTime();
  await writeFile(filePath, `${dshStepLines(1, oldTime, 'deepseek-v4-flash', { inputTokens: 10, outputTokens: 5 }).join('\n')}\n`, 'utf8');

  await withDshHome(tempHome, async () => {
    const { result } = await parseDeepseekIncremental({}, SINCE);
    assert.equal(result.eventsParsed, 0);
    assert.equal(result.buckets.length, 0);
  });
});

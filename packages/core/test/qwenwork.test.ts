import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  estimateQwenworkTokens,
  isQwenCjkCodePoint,
  parseQwenworkIncremental,
} from '../src/parsers/qwenwork.js';
import { computeTotalTokens } from '../src/parsers/shared.js';
import type { CursorsFile } from '../src/types.js';

const SINCE = '2020-01-01T00:00:00.000Z';

/**
 * Redirect `os.homedir()` (used by `qwenworkProjectsDirs`) to a temp dir and
 * write a session JSONL under `<home>/.qwenworkcn/projects/<project>/<id>.jsonl`.
 */
async function withQwenworkHome(
  run: (home: string, ctx: { writeSession: (id: string, lines: unknown[]) => Promise<string> }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'tud-qw-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const writeSession = async (id: string, lines: unknown[]): Promise<string> => {
      const dir = join(home, '.qwenworkcn', 'projects', 'C--work-demo');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${id}.jsonl`);
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return file;
    };
    await run(home, { writeSession });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

/**
 * An assistant fragment sharing `messageId`.
 *
 * Real transcripts close every turn with a non-null `stop_reason` on the last
 * fragment (`tool_use` / `end_turn`); intermediate fragments use `null`. Tests
 * must mirror that, since `stop_reason` is what marks a turn billable.
 */
function assistantFragment(
  messageId: string,
  block: Record<string, unknown>,
  opts: { ts?: string; model?: string; stop?: string | null } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    timestamp: opts.ts ?? '2026-08-03T12:51:20.575Z',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: opts.model ?? 'qwork-lite',
      stop_reason: opts.stop !== undefined ? opts.stop : null,
      content: [block],
    },
  };
}

function userText(text: string, ts = '2026-08-03T12:51:14.237Z'): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function userToolResult(toolUseId: string, content: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-08-03T12:51:21.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
    },
  };
}

function emptyCursors(): CursorsFile {
  return {};
}

test('estimateQwenworkTokens counts CJK at ~1/char and others at ~1/4', () => {
  assert.equal(estimateQwenworkTokens(''), 0);
  assert.equal(estimateQwenworkTokens('你好'), 2);
  assert.equal(estimateQwenworkTokens('abcd'), 1);
  assert.equal(estimateQwenworkTokens('abcdefgh'), 2);
  // Mixed: 2 CJK + 8 ascii → 2 + ceil(8/4) = 4
  assert.equal(estimateQwenworkTokens('你好abcdefgh'), 4);
});

test('isQwenCjkCodePoint covers punctuation, kana, ext-A, fullwidth', () => {
  assert.equal(isQwenCjkCodePoint('、'.codePointAt(0)), true);
  assert.equal(isQwenCjkCodePoint('あ'.codePointAt(0)), true);
  assert.equal(isQwenCjkCodePoint('㐀'.codePointAt(0)), true); // ext-A
  assert.equal(isQwenCjkCodePoint('！'.codePointAt(0)), true); // fullwidth
  assert.equal(isQwenCjkCodePoint('你'.codePointAt(0)), true);
  assert.equal(isQwenCjkCodePoint('a'.codePointAt(0)), false);
});

test('aggregates every fragment of one message.id into a single turn', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    const id = 'chatcmpl-agg';
    await writeSession('s-agg', [
      userText('hello there'),
      assistantFragment(id, { type: 'thinking', thinking: '想一想' }),
      assistantFragment(id, { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } }, { stop: 'tool_use' }),
      assistantFragment(id, { type: 'text', text: 'done' }, { stop: 'end_turn' }),
      userToolResult('call_1', 'file body'),
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    assert.equal(result.eventsParsed, 1, 'one turn, not three fragments');
    assert.equal(result.buckets.length, 1);

    const bucket = result.buckets[0]!;
    // reasoning comes from the thinking block only; output from tool_use + text.
    assert.ok(bucket.reasoning_output_tokens > 0, 'thinking billed as reasoning');
    assert.ok(bucket.output_tokens > 0, 'tool_use + text billed as output');
    assert.equal(bucket.cached_input_tokens, 0);
    assert.equal(bucket.cache_creation_input_tokens, 0);
  });
});

test('input equals the full rebuilt context and grows with each turn', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    await writeSession('s-ctx', [
      userText('first question'),
      assistantFragment('m1', { type: 'text', text: 'first answer' }, { ts: '2026-08-03T12:51:20.000Z', stop: 'end_turn' }),
      // Different half-hour so the two turns land in separate buckets.
      userText('second question', '2026-08-03T13:01:00.000Z'),
      assistantFragment('m2', { type: 'text', text: 'second answer' }, { ts: '2026-08-03T13:02:00.000Z', stop: 'end_turn' }),
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    assert.equal(result.eventsParsed, 2);
    const byHour = result.buckets.slice().sort((a, b) => a.hour_start.localeCompare(b.hour_start));
    const [b1, b2] = byHour;
    assert.ok(b1 && b2);
    // Turn 2 sees turn 1's output in context, so its input is strictly larger.
    assert.ok(
      b2.input_tokens > b1.input_tokens,
      `second input (${b2.input_tokens}) should exceed first (${b1.input_tokens})`,
    );
  });
});

test('compact_boundary resets context to postTokens and never bills preTokens', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    await writeSession('s-compact', [
      userText('a rather long question '.repeat(50)),
      assistantFragment('m1', { type: 'text', text: 'answer '.repeat(50) }, { ts: '2026-08-03T12:51:20.000Z', stop: 'end_turn' }),
      {
        type: 'system',
        uuid: 'sys-1',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        timestamp: '2026-08-03T12:51:30.000Z',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 999_999,
          messagesSummarized: 10,
          postTokens: 100,
          durationMs: 1000,
        },
      },
      userText('next question', '2026-08-03T13:01:00.000Z'),
      assistantFragment('m2', { type: 'text', text: 'next answer' }, { ts: '2026-08-03T13:02:00.000Z', stop: 'end_turn' }),
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    assert.equal(result.eventsParsed, 2, 'both turns billed');
    // The post-compaction turn lives in the 13:00 half-hour bucket.
    const m2 = result.buckets.find((b) => b.hour_start.includes('13:00'));
    assert.ok(m2, 'post-compact turn has its own bucket');
    // Post-compaction context ≈ 100 (+ the follow-up user text), nowhere near
    // the 999_999 preTokens that was discarded.
    assert.ok(m2.input_tokens < 1000, `input ${m2.input_tokens} must not use preTokens`);
    assert.ok(m2.input_tokens >= 100, 'input seeded from postTokens');
  });
});

test('second run is idempotent and only bills newly appended turns', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    const file = await writeSession('s-inc', [
      userText('q1'),
      assistantFragment('m1', { type: 'text', text: 'a1' }, { stop: 'end_turn' }),
    ]);

    const cursors = emptyCursors();
    const first = await parseQwenworkIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 1);

    // Re-run with the same cursors: nothing new.
    const again = await parseQwenworkIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0);
    assert.equal(again.result.buckets.length, 0);

    // Append another turn; only it should be billed, and its input should
    // include the replayed history (proof the context cursor resumed).
    const appended = [
      userText('q2', '2026-08-03T13:00:00.000Z'),
      assistantFragment('m2', { type: 'text', text: 'a2' }, { ts: '2026-08-03T13:00:10.000Z', stop: 'end_turn' }),
    ];
    const prev = await readFile(file, 'utf8');
    await writeFile(file, prev + appended.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const third = await parseQwenworkIncremental(cursors, SINCE);
    assert.equal(third.result.eventsParsed, 1);
    assert.ok(third.result.buckets[0]!.input_tokens > 0, 'resumed context is non-zero');
  });
});

test('total_tokens is the plain sum of the five disjoint fields', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    await writeSession('s-total', [
      userText('question'),
      assistantFragment('m1', { type: 'thinking', thinking: '思考' }),
      assistantFragment('m1', { type: 'text', text: 'answer' }),
      userToolResult('call_x', 'result'),
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    const b = result.buckets[0]!;
    assert.equal(
      b.total_tokens,
      computeTotalTokens({
        input_tokens: b.input_tokens,
        output_tokens: b.output_tokens,
        cached_input_tokens: b.cached_input_tokens,
        cache_creation_input_tokens: b.cache_creation_input_tokens,
        reasoning_output_tokens: b.reasoning_output_tokens,
      }),
    );
  });
});

test('ignores file-history-snapshot and other local bookkeeping records', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    await writeSession('s-meta', [
      { type: 'workspace-directories', sessionId: 's-meta', directories: ['C:\\big'] },
      { type: 'runtime-config', sessionId: 's-meta', model: 'qwork-lite', contextWindow: 1_000_000 },
      // A snapshot carrying a big blob must not enter the context.
      { type: 'file-history-snapshot', uuid: 'fh-1', files: { 'a.ts': 'x'.repeat(100_000) } },
      { type: 'active-leaf', sessionId: 's-meta', leafUuid: 'x' },
      userText('small question'),
      assistantFragment('m1', { type: 'text', text: 'small answer' }, { stop: 'end_turn' }),
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    const b = result.buckets[0]!;
    assert.ok(b.input_tokens < 1000, `snapshot leaked into input: ${b.input_tokens}`);
  });
});

test('ignores isSidechain records', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    await writeSession('s-side', [
      userText('q'),
      { ...assistantFragment('m-side', { type: 'text', text: 'subagent reply' }), isSidechain: true },
      assistantFragment('m1', { type: 'text', text: 'main reply' }, { stop: 'end_turn' }),
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    // Only the main-thread turn is billed.
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets.length, 1);
  });
});

test('truncated file rebuilds the context instead of resuming', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    const file = await writeSession('s-trunc', [
      userText('q1'),
      assistantFragment('m1', { type: 'text', text: 'a1' }),
    ]);

    const cursors = emptyCursors();
    await parseQwenworkIncremental(cursors, SINCE);

    // Rewrite with fewer bytes: cursor must not resume from a stale line.
    await writeFile(file, JSON.stringify(userText('q-new')) + '\n');
    const after = await parseQwenworkIncremental(cursors, SINCE);
    // The truncated file has no complete turn yet, so nothing is billed but
    // the run must not throw and must reset the stored line count.
    assert.ok(after.result.filesProcessed >= 0);
    assert.equal(after.result.eventsParsed, 0);
  });
});

test('reports unknown model when message.model is absent', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    await writeSession('s-model', [
      userText('q'),
      {
        type: 'assistant',
        uuid: 'u-1',
        timestamp: '2026-08-03T12:51:20.000Z',
        message: {
          id: 'm-no-model',
          type: 'message',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'answer' }],
        },
      },
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    assert.equal(result.buckets[0]!.model, 'unknown');
  });
});

test('adopts the timestamp of a later fragment when the first lacks one', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    await writeSession('s-ts', [
      userText('q'),
      {
        type: 'assistant',
        uuid: 'u-1',
        // No timestamp on the first fragment.
        message: {
          id: 'm-ts',
          type: 'message',
          role: 'assistant',
          model: 'qwork-lite',
          stop_reason: null,
          content: [{ type: 'thinking', thinking: 'hmm' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'u-2',
        timestamp: '2026-08-03T12:51:20.000Z',
        message: {
          id: 'm-ts',
          type: 'message',
          role: 'assistant',
          model: 'qwork-lite',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'answer' }],
        },
      },
    ]);

    const { result } = await parseQwenworkIncremental(emptyCursors(), SINCE);
    assert.equal(result.eventsParsed, 1, 'turn billed via the adopted timestamp');
  });
});

test('an unfinished trailing turn stays pending and is billed once completed', async () => {
  await withQwenworkHome(async (_home, { writeSession }) => {
    const file = await writeSession('s-pending', [
      userText('q1'),
      // Thinking fragment written while the model is still streaming: the turn
      // has no closing `stop_reason` yet, so it must NOT be billed.
      assistantFragment('m1', { type: 'thinking', thinking: 'partial thought' }),
    ]);

    const cursors = emptyCursors();
    const first = await parseQwenworkIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 0, 'incomplete turn is not billed');

    // The stream finishes: tool_use fragment arrives carrying `stop_reason`.
    const rest = [
      assistantFragment('m1', { type: 'tool_use', name: 't', input: {} }, { stop: 'tool_use' }),
      userToolResult('call_1', 'ok'),
    ];
    const prev = await readFile(file, 'utf8');
    await writeFile(file, prev + rest.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const second = await parseQwenworkIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1, 'turn billed exactly once, after completion');
  });
});

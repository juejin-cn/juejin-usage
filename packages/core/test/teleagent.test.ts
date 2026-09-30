import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseTeleagentIncremental } from '../src/parsers/teleagent.js';
import { computeTotalTokens } from '../src/parsers/shared.js';
import type { CursorsFile } from '../src/types.js';

const SINCE = '2020-01-01T00:00:00.000Z';

/** TeleAgent 服务端日志中的模型注册行（早于 cost 行出现，携带 request_id）。 */
function modelLine(requestId: string, model: string, ts = '2026/09/21 09:49:34.123456'): string {
  return `${ts} registry.go:204: [Info] [request_id:${requestId}] [Registry] GetModelCapabilities provider="NewApi" model="${model}" capabilities={Temperature:false Reasoning:false Attachment:false ToolCall:true}`;
}

/** TeleAgent 服务端日志中的计费行：积分制下 cost 恒为 $0，token 真实记录。 */
function costLine(
  requestId: string,
  input: number,
  out: number,
  cache: number,
  ts = '2026/09/21 09:49:46.820855',
): string {
  return `${ts} processor.go:806: [Info] [request_id:${requestId}] [cost] provider=NewApi tokens(in=${input} out=${out} cacheRead=${cache}) cost=$0.000000`;
}

async function withLogs(
  lines: string[],
  run: (file: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tud-teleagent-'));
  const logDir = join(dir, 'u-1', 'log');
  await mkdir(logDir, { recursive: true });
  const file = join(logDir, 'super-agent-server-test.log');
  await writeFile(file, lines.join('\n') + '\n');
  const prev = process.env.AI_USAGE_TELEAGENT_LOGS;
  process.env.AI_USAGE_TELEAGENT_LOGS = dir;
  try {
    await run(file);
  } finally {
    if (prev === undefined) delete process.env.AI_USAGE_TELEAGENT_LOGS;
    else process.env.AI_USAGE_TELEAGENT_LOGS = prev;
  }
}

function emptyCursors(): CursorsFile {
  return {};
}

test('parses cost lines into buckets and resolves model via request_id', async () => {
  await withLogs(
    [
      modelLine('a-0001', 'chat-pro'),
      costLine('a-0001', 100, 50, 200),
      modelLine('b-0002', 'deepseek-v3'),
      costLine('b-0002', 300, 80, 0),
    ],
    async () => {
      const { result } = await parseTeleagentIncremental(emptyCursors(), SINCE);
      assert.equal(result.eventsParsed, 2);
      assert.equal(result.buckets.length, 2);

      const byModel = new Map(result.buckets.map((b) => [b.model, b]));
      const chat = byModel.get('chat-pro')!;
      assert.ok(chat, 'chat-pro bucket exists');
      assert.equal(chat.input_tokens, 100);
      assert.equal(chat.output_tokens, 50);
      assert.equal(chat.cached_input_tokens, 200);
      assert.equal(chat.conversation_count, 1);

      const ds = byModel.get('deepseek-v3')!;
      assert.ok(ds, 'deepseek-v3 bucket exists');
      assert.equal(ds.input_tokens, 300);
      assert.equal(ds.output_tokens, 80);
      assert.equal(ds.cached_input_tokens, 0);

      for (const b of result.buckets) {
        assert.equal(b.source, 'teleagent');
        assert.equal(b.collector, 'teleagent');
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
      }
    },
  );
});

test('aggregates repeated cost lines of the same model into one bucket', async () => {
  await withLogs(
    [
      modelLine('m-1', 'chat-pro'),
      costLine('m-1', 100, 50, 200),
      costLine('m-1', 50, 25, 0),
    ],
    async () => {
      const { result } = await parseTeleagentIncremental(emptyCursors(), SINCE);
      assert.equal(result.eventsParsed, 2, 'both cost lines parsed');
      assert.equal(result.buckets.length, 1, 'same model + half-hour merges');
      const b = result.buckets[0]!;
      assert.equal(b.input_tokens, 150);
      assert.equal(b.output_tokens, 75);
      assert.equal(b.cached_input_tokens, 200);
      assert.equal(b.conversation_count, 2);
    },
  );
});

test('splits buckets across half-hour boundaries', async () => {
  await withLogs(
    [
      modelLine('m-1', 'chat-pro'),
      costLine('m-1', 10, 1, 0, '2026/09/21 09:29:46.000000'),
      costLine('m-1', 20, 2, 0, '2026/09/21 10:01:00.000000'),
    ],
    async () => {
      const { result } = await parseTeleagentIncremental(emptyCursors(), SINCE);
      assert.equal(result.eventsParsed, 2);
      assert.equal(result.buckets.length, 2);
      const starts = result.buckets.map((b) => b.hour_start).sort();
      assert.notEqual(starts[0], starts[1], 'two distinct half-hours');
    },
  );
});

test('second run is idempotent and only bills appended lines', async () => {
  await withLogs([modelLine('a-0001', 'chat-pro'), costLine('a-0001', 10, 2, 0)], async (file) => {
    const cursors = emptyCursors();
    const first = await parseTeleagentIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 1);

    const again = await parseTeleagentIncremental(cursors, SINCE);
    assert.equal(again.result.eventsParsed, 0, 'no re-billing');
    assert.equal(again.result.buckets.length, 0);

    await appendFile(
      file,
      modelLine('b-0002', 'deepseek-v3', '2026/09/21 10:03:00.000000') +
        '\n' +
        costLine('b-0002', 7, 1, 0, '2026/09/21 10:03:30.000000') +
        '\n',
    );
    const third = await parseTeleagentIncremental(cursors, SINCE);
    assert.equal(third.result.eventsParsed, 1, 'only the appended line');
    assert.equal(third.result.buckets[0]!.model, 'deepseek-v3');
  });
});

test('zero-token cost lines and non-cost noise are ignored', async () => {
  await withLogs(
    [
      '2026/09/21 09:00:00.000000 [Info] [request_id:none] session started',
      modelLine('a-0001', 'chat-pro'),
      costLine('a-0001', 0, 0, 0),
      '2026/09/21 09:01:00.000000 [Info] [cost] provider=NewApi tokens(in=abc out=def cacheRead=0) cost=$0.000000',
    ],
    async () => {
      const { result } = await parseTeleagentIncremental(emptyCursors(), SINCE);
      assert.equal(result.eventsParsed, 0, 'no billable cost lines');
      assert.equal(result.buckets.length, 0);
    },
  );
});

test('model resolves to unknown when no registration line is seen', async () => {
  await withLogs([costLine('lonely-1', 5, 1, 0)], async () => {
    const { result } = await parseTeleagentIncremental(emptyCursors(), SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets[0]!.model, 'unknown');
  });
});

test('truncated file restarts from the top without error', async () => {
  await withLogs(
    [modelLine('a-0001', 'chat-pro'), costLine('a-0001', 10, 2, 0)],
    async (file) => {
      const cursors = emptyCursors();
      const first = await parseTeleagentIncremental(cursors, SINCE);
      assert.equal(first.result.eventsParsed, 1);

      // 日志被外部截断重写（常见于 logrotate），游标必须回退而不是异常。
      await writeFile(file, modelLine('b-0002', 'chat-pro', '2026/09/21 11:00:00.000000') + '\n');
      const after = await parseTeleagentIncremental(cursors, SINCE);
      assert.ok(after.result.filesProcessed >= 1, 'file still processed');
      assert.equal(after.result.eventsParsed, 0, 'partial line has no [cost] yet');
    },
  );
});
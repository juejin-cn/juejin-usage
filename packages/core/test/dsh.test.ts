import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import test from 'node:test';

import { parseDshIncremental, listDshSessionFiles, dshHome } from '../src/parsers/dsh.js';
import type { CursorsFile } from '../src/types.js';

const SINCE = '2020-01-01T00:00:00.000Z';

function zstdJsonl(lines: unknown[]): Buffer {
  return zlib.zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
}

/** 多帧压缩（每行一个独立 zstd 帧拼接），模拟 DSH 流式追加写入的真实文件。 */
function zstdJsonlMultiFrame(lines: unknown[]): Buffer {
  return Buffer.concat(
    lines.map((l) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(l) + '\n'))),
  );
}

/** 构造一个 DSH 会话文件并写入临时 DSH_HOME，返回会话文件路径。 */
function writeSession(
  home: string,
  workspace: string,
  sessionId: string,
  cwd: string,
  messages: Array<{
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite?: number;
    reasoning?: number;
    id: string;
    time: number;
  }>,
  opts: {
    multiFrame?: boolean;
    plain?: boolean;
    requestModel?: string;
    omitMessageModel?: boolean;
    version?: number;
    filename?: string;
  } = {},
): string {
  const dir = workspace ? join(home, 'sessions', workspace, sessionId) : join(home, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const lines: unknown[] = [
    { type: 'session', version: opts.version ?? 0, id: sessionId, createdAt: 1787830821841, cwd },
  ];
  if (opts.requestModel) {
    lines.push({
      type: 'request/header',
      seq: 1,
      time: messages[0]?.time ?? 1787830821841,
      data: { header: { config: { model: opts.requestModel } } },
    });
  }
  for (const m of messages) {
    // 每个 assistant 消息同时产出 chunk（流式）与 message（最终），chunk 应被忽略。
    const chunkUsage = {
      inputTokens: m.input,
      outputTokens: m.output,
      cacheReadTokens: m.cacheRead,
      cacheWriteTokens: m.cacheWrite ?? 0,
      ...(m.reasoning !== undefined ? { reasoningTokens: m.reasoning } : {}),
    };
    lines.push({
      type: 'assistant/chunk',
      seq: 1,
      time: m.time,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: chunkUsage } },
    });
    lines.push({
      type: 'assistant/message',
      seq: 2,
      time: m.time,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: m.id,
          content: [{ type: 'text', text: 'hi' }],
          source: {
            kind: 'model',
            provider: 'api',
            ...(opts.omitMessageModel ? {} : { model: m.model }),
          },
        },
        usage: chunkUsage,
      },
    });
  }
  // 一条 tool/result 带 usage，应被忽略。
  lines.push({
    type: 'tool/result',
    seq: 999,
    time: 1787830861600,
    data: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 } },
  });
  const defaultName = opts.version !== undefined
    ? `session.v${opts.version}.jsonl${opts.plain ? '' : '.zstd'}`
    : opts.plain
      ? 'session.jsonl'
      : 'session.jsonl.zstd';
  const file = join(dir, opts.filename ?? defaultName);
  const contents = file.endsWith('.zstd')
    ? opts.multiFrame
      ? zstdJsonlMultiFrame(lines)
      : zstdJsonl(lines)
    : Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(file, contents);
  return file;
}

function emptyCursors(): CursorsFile {
  return {};
}

test('dshHome defaults to ~/.dsh and honors DSH_HOME', () => {
  const prev = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    assert.ok(dshHome().endsWith(join('.dsh')));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
  process.env.DSH_HOME = '/x/custom';
  assert.equal(dshHome(), '/x/custom');
});

test('listDshSessionFiles discovers session files', () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-list-'));
  try {
    writeSession(home, 'ws-a', 's1', '/tmp/proj/a', []);
    writeSession(home, 'ws-b', 's2', '/tmp/proj/b', [], { plain: true });
    const files = listDshSessionFiles(home);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith('session.jsonl.zstd')));
    assert.ok(files.some((f) => f.endsWith('session.jsonl')));
  } finally {
    // cleanup
  }
});

test('parseDshIncremental parses usage, model, project from zstd sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeSession(home, 'ws-a', 's1', '/tmp/proj/foo', [
      {
        model: 'deepseek-v4-pro',
        input: 100,
        output: 50,
        cacheRead: 200,
        cacheWrite: 25,
        id: 'm1',
        time: 1787830861590,
      },
    ]);
    const { result } = await parseDshIncremental(emptyCursors(), SINCE);

    assert.equal(result.eventsParsed, 1);
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.buckets.length, 1);
    const b = result.buckets[0]!;
    assert.equal(b.source, 'dsh');
    assert.equal(b.model, 'deepseek-v4-pro');
    assert.equal(b.project, 'foo');
    assert.equal(b.input_tokens, 100);
    assert.equal(b.output_tokens, 50);
    assert.equal(b.cached_input_tokens, 200);
    assert.equal(b.cache_creation_input_tokens, 25);
    assert.equal(b.reasoning_output_tokens, 0);
    assert.equal(b.total_tokens, 375);
    assert.equal(b.conversation_count, 1);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('parseDshIncremental reads plain JSONL and falls back to request/header model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-plain-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeSession(home, 'ws-a', 's1', '/tmp/proj/plain', [
      { model: '', input: 10, output: 5, cacheRead: 2, id: 'm1', time: 1787830861590 },
    ], {
      plain: true,
      requestModel: 'deepseek-v4-pro',
      omitMessageModel: true,
    });

    const { result } = await parseDshIncremental(emptyCursors(), SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]!.model, 'deepseek-v4-pro');
    assert.equal(result.buckets[0]!.project, 'plain');
    assert.equal(result.buckets[0]!.total_tokens, 17);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('parseDshIncremental is idempotent for unchanged files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-idem-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeSession(home, 'ws-a', 's1', '/tmp/proj/foo', [
      { model: 'deepseek-v4-pro', input: 100, output: 50, cacheRead: 200, id: 'm1', time: 1787830861590 },
    ]);

    let cursors: CursorsFile = {};
    const first = await parseDshIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    cursors = first.cursors;

    // 文件未变：eventsParsed 应为 0，不再重复计数。
    const second = await parseDshIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 0);
    assert.equal(second.result.filesProcessed, 1);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('parseDshIncremental only emits newly appended messages after a file changes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-append-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    let cursors: CursorsFile = {};
    writeSession(home, 'ws-a', 's1', '/tmp/proj/foo', [
      { model: 'deepseek-v4-pro', input: 100, output: 50, cacheRead: 200, id: 'm1', time: 1787830861590 },
    ]);

    const first = await parseDshIncremental(cursors, SINCE);
    assert.equal(first.result.eventsParsed, 1);
    cursors = first.cursors;

    // DSH 会重写/追加同一个多帧文件；重扫时旧消息不能再次累计。
    writeSession(home, 'ws-a', 's1', '/tmp/proj/foo', [
      { model: 'deepseek-v4-pro', input: 100, output: 50, cacheRead: 200, id: 'm1', time: 1787830861590 },
      { model: 'deepseek-v4-pro', input: 7, output: 3, cacheRead: 11, id: 'm2', time: 1787830862590 },
    ]);

    const second = await parseDshIncremental(cursors, SINCE);
    assert.equal(second.result.eventsParsed, 1);
    assert.equal(second.result.buckets.length, 1);
    const bucket = second.result.buckets[0]!;
    assert.equal(bucket.input_tokens, 7);
    assert.equal(bucket.output_tokens, 3);
    assert.equal(bucket.cached_input_tokens, 11);
    assert.equal(bucket.total_tokens, 21);
    assert.equal(bucket.conversation_count, 1);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('parseDshIncremental decodes multi-frame zstd (streamed session files)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-mf-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // 多点消息，模拟真实流式追加的会话文件。
    writeSession(home, 'ws-a', 's1', '/tmp/proj/multi', [
      { model: 'deepseek-v4-pro', input: 10, output: 5, cacheRead: 20, id: 'm1', time: 1787830861590 },
      { model: 'glm-5.2', input: 7, output: 3, cacheRead: 11, id: 'm2', time: 1787830862590 },
      { model: 'deepseek-v4-pro', input: 8, output: 2, cacheRead: 9, id: 'm3', time: 1787830863590 },
    ], { multiFrame: true });

    const { result } = await parseDshIncremental(emptyCursors(), SINCE);

    assert.equal(result.eventsParsed, 3);
    assert.equal(result.filesProcessed, 1);
    // 按 (model, hour) 聚合：两条 deepseek-v4-pro 落在同一半小时 bucket 会合并。
    const byModel: Record<string, { input: number; output: number; cacheRead: number }> = {};
    for (const b of result.buckets) {
      const e = byModel[b.model] ?? (byModel[b.model] = { input: 0, output: 0, cacheRead: 0 });
      e.input += b.input_tokens;
      e.output += b.output_tokens;
      e.cacheRead += b.cached_input_tokens;
    }
    assert.deepEqual(byModel['deepseek-v4-pro'], { input: 18, output: 7, cacheRead: 29 });
    assert.deepEqual(byModel['glm-5.2'], { input: 7, output: 3, cacheRead: 11 });
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('listDshSessionFiles supports session.v3.jsonl.zstd and picks higher version', () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-v3-'));
  try {
    // 真实 DSH 目录结构：sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd
    writeSession(home, '--workspace-sample--', 'session-s1', '/tmp/proj/sample', [], { version: 3 });
    // 单层目录结构：sessions/<sessionId>/session.v3.jsonl.zstd
    writeSession(home, '', 'session-single', '/tmp/proj/single', [], { version: 3 });
    // 同一目录存在 v2 和 v3，应选更高版本的 v3
    writeSession(home, 'ws-multi', 'session-multi', '/tmp/proj/multi', [], { filename: 'session.v2.jsonl.zstd' });
    writeSession(home, 'ws-multi', 'session-multi', '/tmp/proj/multi', [], { filename: 'session.v3.jsonl.zstd' });

    const files = listDshSessionFiles(home);
    assert.equal(files.length, 3);
    assert.ok(files.some((f) => f.includes('session-s1') && f.endsWith('session.v3.jsonl.zstd')));
    assert.ok(files.some((f) => f.includes('session-single') && f.endsWith('session.v3.jsonl.zstd')));
    assert.ok(files.some((f) => f.includes('session-multi') && f.endsWith('session.v3.jsonl.zstd')));
  } finally {
    // cleanup
  }
});

test('parseDshIncremental parses session.v3.jsonl.zstd with reasoning tokens', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tud-dsh-v3-parse-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeSession(
      home,
      '--workspace-demo--',
      'session-demo-7b06',
      '/demo/workspace/sample-app',
      [
        {
          model: 'deepseek-flash',
          input: 8693,
          output: 189,
          cacheRead: 500,
          cacheWrite: 20,
          reasoning: 74,
          id: 'm-flash-1',
          time: 1789026072131,
        },
      ],
      { version: 3, multiFrame: true },
    );

    const { result } = await parseDshIncremental(emptyCursors(), SINCE);
    assert.equal(result.eventsParsed, 1);
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.buckets.length, 1);

    const b = result.buckets[0]!;
    assert.equal(b.source, 'dsh');
    assert.equal(b.model, 'deepseek-flash');
    assert.equal(b.project, 'sample-app');
    assert.equal(b.input_tokens, 8693);
    assert.equal(b.output_tokens, 189);
    assert.equal(b.cached_input_tokens, 500);
    assert.equal(b.cache_creation_input_tokens, 20);
    assert.equal(b.reasoning_output_tokens, 74);
    assert.equal(b.total_tokens, 8693 + 189 + 500 + 20);
    assert.equal(b.conversation_count, 1);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});


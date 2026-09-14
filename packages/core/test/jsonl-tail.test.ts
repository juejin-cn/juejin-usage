import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { readJsonlTail } from '../src/parsers/jsonl-tail.js';

async function tempFile(name: string, content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tud-jsonl-tail-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

function collect() {
  const lines: string[] = [];
  return { lines, onLine: (line: string) => void lines.push(line) };
}

test('readJsonlTail commits newline-terminated lines and reports their end', async () => {
  const body = '{"a":1}\n{"a":2}\n';
  const path = await tempFile('a.jsonl', body);
  const sink = collect();
  const { nextOffset, pendingPartial } = await readJsonlTail(path, { onLine: sink.onLine });
  assert.deepEqual(sink.lines, ['{"a":1}', '{"a":2}']);
  assert.equal(nextOffset, Buffer.byteLength(body));
  assert.equal(pendingPartial, false);
});

test('readJsonlTail leaves a half-written tail line for the next round', async () => {
  const complete = '{"a":1}\n';
  const partial = '{"a":2,"b":';
  const path = await tempFile('b.jsonl', complete + partial);
  const first = collect();
  const firstRead = await readJsonlTail(path, { onLine: first.onLine });
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(firstRead.pendingPartial, true);
  // Cursor stops at the partial line's first byte, not at EOF.
  assert.equal(firstRead.nextOffset, Buffer.byteLength(complete));

  // Writer finishes the record and appends another one.
  await appendFile(path, '2}\n{"a":3}\n');
  const second = collect();
  const secondRead = await readJsonlTail(path, {
    start: firstRead.nextOffset,
    onLine: second.onLine,
  });
  assert.deepEqual(second.lines, ['{"a":2,"b":2}', '{"a":3}']);
  assert.equal(secondRead.pendingPartial, false);
});

test('readJsonlTail commits an unterminated but complete final record', async () => {
  const body = '{"a":1}\n{"a":2}';
  const path = await tempFile('c.jsonl', body);
  const sink = collect();
  const { nextOffset, pendingPartial } = await readJsonlTail(path, { onLine: sink.onLine });
  assert.deepEqual(sink.lines, ['{"a":1}', '{"a":2}']);
  assert.equal(nextOffset, Buffer.byteLength(body));
  assert.equal(pendingPartial, false);
});

test('readJsonlTail keeps multi-byte characters intact across chunk boundaries', async () => {
  // Long enough to span several 64KiB read chunks, with a 3-byte character
  // sitting at a boundary-crossing position.
  const filler = '漢'.repeat(70_000);
  const body = `${JSON.stringify({ text: filler })}\n${JSON.stringify({ a: 2 })}\n`;
  const path = await tempFile('d.jsonl', body);
  const sink = collect();
  const { nextOffset } = await readJsonlTail(path, { onLine: sink.onLine });
  assert.equal(sink.lines.length, 2);
  assert.equal((JSON.parse(sink.lines[0]!) as { text: string }).text, filler);
  assert.equal(nextOffset, Buffer.byteLength(body));
});

test('readJsonlTail handles CRLF and blank lines', async () => {
  const body = '{"a":1}\r\n\r\n{"a":2}\r\n';
  const path = await tempFile('e.jsonl', body);
  const sink = collect();
  const { nextOffset } = await readJsonlTail(path, { onLine: sink.onLine });
  assert.deepEqual(sink.lines, ['{"a":1}', '{"a":2}']);
  assert.equal(nextOffset, Buffer.byteLength(body));
});

test('readJsonlTail advances past a corrupt newline-terminated line', async () => {
  // Not valid JSON but fully written: skipping keeps the cursor moving.
  const body = '{"a":1}\nnot json at all\n{"a":2}\n';
  const path = await tempFile('f.jsonl', body);
  const sink = collect();
  const { nextOffset, pendingPartial } = await readJsonlTail(path, { onLine: sink.onLine });
  assert.deepEqual(sink.lines, ['{"a":1}', 'not json at all', '{"a":2}']);
  assert.equal(nextOffset, Buffer.byteLength(body));
  assert.equal(pendingPartial, false);
});

test('readJsonlTail resumes exactly at the requested offset', async () => {
  const head = '{"a":1}\n';
  const body = `${head}{"a":2}\n`;
  const path = await tempFile('g.jsonl', body);
  const sink = collect();
  const { nextOffset } = await readJsonlTail(path, {
    start: Buffer.byteLength(head),
    onLine: sink.onLine,
  });
  assert.deepEqual(sink.lines, ['{"a":2}']);
  assert.equal(nextOffset, Buffer.byteLength(body));
});

test('readJsonlTail stops early when onLine returns false', async () => {
  const body = '{"a":1}\n{"a":2}\n{"a":3}\n';
  const path = await tempFile('h.jsonl', body);
  const lines: string[] = [];
  const { nextOffset } = await readJsonlTail(path, {
    onLine: (line) => {
      lines.push(line);
      return lines.length < 2;
    },
  });
  assert.deepEqual(lines, ['{"a":1}', '{"a":2}']);
  assert.equal(nextOffset, Buffer.byteLength('{"a":1}\n{"a":2}\n'));
});

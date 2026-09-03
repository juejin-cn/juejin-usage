import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  accumulateBucket,
  findJsonlFiles,
  resetJsonlWalkCache,
} from '../src/parsers/shared.js';
import type { TokenTotals } from '../src/types.js';

test('findJsonlFiles reuses directory listing when mtime is unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-jsonl-walk-'));
  resetJsonlWalkCache();
  try {
    const nested = join(dir, 'sess');
    await mkdir(nested);
    const a = join(nested, 'a.jsonl');
    await writeFile(a, '{}\n', 'utf8');

    const first = await findJsonlFiles(dir);
    assert.deepEqual(first.sort(), [a]);

    // Same tree: second walk should still return the known file (cache hit).
    const second = await findJsonlFiles(dir);
    assert.deepEqual(second.sort(), [a]);

    const b = join(nested, 'b.jsonl');
    await writeFile(b, '{}\n', 'utf8');
    const third = await findJsonlFiles(dir);
    assert.deepEqual(third.sort(), [a, b]);
  } finally {
    resetJsonlWalkCache();
    await rm(dir, { recursive: true, force: true });
  }
});

function tokenDelta(total: number): TokenTotals {
  return {
    input_tokens: total,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    conversation_count: 1,
  };
}

test('accumulateBucket decodes URI-encoded cwd and merges with folder name', () => {
  const state = new Map();
  const hour = '2026-07-24T15:00:00.000Z';
  accumulateBucket(
    state,
    'grok',
    'grok-4',
    '%2FUsers%2Fme%2Fcode%2Fai-usage',
    hour,
    tokenDelta(200),
  );
  accumulateBucket(state, 'grok', 'grok-4', 'ai-usage', hour, tokenDelta(100));

  assert.equal(state.size, 1);
  const row = [...state.values()][0]!;
  assert.equal(row.project, 'ai-usage');
  assert.equal(row.total_tokens, 300);
});

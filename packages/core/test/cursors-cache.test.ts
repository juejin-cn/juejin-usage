import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadCursors,
  resetCursorsCache,
  saveCursors,
  syncMutatedCursors,
} from '../src/queue/index.js';

test('saveCursors skips rewrite when serialized content is unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-cursors-'));
  resetCursorsCache(dir);
  try {
    const cursors = { claude: { files: {}, seenHashes: [], seenUsage: {} } };
    await saveCursors(dir, cursors);
    const path = join(dir, 'cursors.json');
    const before = await stat(path);

    await saveCursors(dir, cursors);
    const after = await stat(path);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    resetCursorsCache(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadCursors returns the cached object without re-reading disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tud-cursors-load-'));
  resetCursorsCache(dir);
  try {
    await saveCursors(dir, { claude: { files: {}, seenHashes: ['a'], seenUsage: {} } });
    const first = await loadCursors(dir);
    await writeFile(join(dir, 'cursors.json'), '{"tampered":true}\n', 'utf8');
    const second = await loadCursors(dir);
    assert.equal(first, second);
    assert.deepEqual(second.claude?.seenHashes, ['a']);
  } finally {
    resetCursorsCache(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncMutatedCursors is false for skipped or empty rounds', () => {
  assert.equal(
    syncMutatedCursors([
      { skipped: true, filesProcessed: 0, bucketsWritten: 0 },
      { filesProcessed: 0, bucketsWritten: 0 },
    ]),
    false,
  );
  assert.equal(
    syncMutatedCursors([{ filesProcessed: 1, bucketsWritten: 0 }]),
    true,
  );
});

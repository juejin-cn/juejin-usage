import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadCursors,
  pruneMissingCursorFiles,
  resetCursorsCache,
  saveCursors,
  shouldSaveCursorsAfterSync,
  syncMutatedCursors,
} from '../src/queue/index.js';

test('pruneMissingCursorFiles drops deleted files whose parent directory still exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tud-prune-cursor-'));
  const logs = join(root, 'logs');
  await mkdir(logs);
  const live = join(logs, 'live.jsonl');
  const deleted = join(logs, 'deleted.jsonl');
  const missingParent = join(root, 'missing-parent', 'gone.jsonl');
  await writeFile(live, '{}\n');
  await writeFile(deleted, '{}\n');
  await unlink(deleted);

  const cursors = {
    codex: {
      files: {
        [live]: { offset: 10, inode: 1 },
        [deleted]: { offset: 20, inode: 2 },
        [missingParent]: { offset: 30, inode: 3 },
        relative: { offset: 40, inode: 4 },
      },
      seenHashes: ['a'],
    },
  };

  try {
    assert.equal(pruneMissingCursorFiles(cursors), 1);
    assert.deepEqual(Object.keys(cursors.codex.files).sort(), [
      live,
      missingParent,
      'relative',
    ].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveCursors persists the pruned files map and keeps non-file cursor state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tud-prune-save-'));
  const logs = join(dataDir, 'logs');
  await mkdir(logs);
  const live = join(logs, 'live.jsonl');
  const deleted = join(logs, 'deleted.jsonl');
  await writeFile(live, '{}\n');
  await writeFile(deleted, '{}\n');
  await unlink(deleted);
  resetCursorsCache(dataDir);

  try {
    await saveCursors(dataDir, {
      codex: {
        files: {
          [live]: { offset: 10, inode: 1 },
          [deleted]: { offset: 20, inode: 2 },
        },
        seenHashes: ['keep-me'],
      },
    });
    resetCursorsCache(dataDir);
    const loaded = await loadCursors(dataDir);
    assert.deepEqual(Object.keys(loaded.codex?.files ?? {}), [live]);
    assert.deepEqual(loaded.codex?.seenHashes, ['keep-me']);
  } finally {
    resetCursorsCache(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('shouldSaveCursorsAfterSync is true when only stale file cursors were pruned', () => {
  const emptyRound = [
    { skipped: true, filesProcessed: 0, bucketsWritten: 0 },
    { filesProcessed: 0, bucketsWritten: 0 },
  ];
  assert.equal(syncMutatedCursors(emptyRound), false);
  assert.equal(shouldSaveCursorsAfterSync(emptyRound, 0), false);
  assert.equal(shouldSaveCursorsAfterSync(emptyRound, 1), true);
});

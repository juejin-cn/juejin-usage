import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { appendJsonLog } from '../src/debug-log.js';
import {
  buildNotifyScript,
  buildNotifySh,
  buildHookCommand,
  writeNotifyScript,
} from '../src/hooks/claude.js';
import {
  isSyncSignalFile,
  syncSignalFilenames,
} from '../src/server/sync-watcher.js';
import {
  LOG_MAX_BYTES,
  NOTIFY_THROTTLE_MS,
  notifyLogPath,
  notifyScriptPath,
  syncDonePath,
  syncLogPath,
} from '../src/paths.js';

const DATA_DIR = '/Users/test/.ai-usage';

test('buildNotifySh writes signal only (no CLI/npx/node spawn sync)', () => {
  const script = buildNotifySh(DATA_DIR);

  assert.ok(script.startsWith('#!/bin/bash'));
  assert.match(script, /notify\.signal/);
  assert.match(script, /"signal"/);
  assert.match(script, new RegExp(String(Math.ceil(NOTIFY_THROTTLE_MS / 1000))));
  assert.match(script, new RegExp(DATA_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.doesNotMatch(script, /\/usr\/bin\/env node/);
  assert.doesNotMatch(script, /cliBinPath/);
  assert.doesNotMatch(script, /fallbackPkg/);
  assert.doesNotMatch(script, /'sync', '--source'/);
  assert.doesNotMatch(script, /npx/);
  assert.doesNotMatch(script, /@juejin-opensource\/jusage/);
  assert.doesNotMatch(script, /fetch\(/);
  assert.doesNotMatch(script, /tud-trigger-sync/);
  assert.doesNotMatch(script, /notify\.error/);
});

test('buildNotifySh normalizes legacy millisecond throttle stamps', () => {
  const script = buildNotifySh(DATA_DIR);
  assert.match(script, /100000000000/);
  assert.match(script, /last \/ 1000/);
  assert.match(script, /head -n 1/);
});

test('buildNotifySh chains original Codex notify via python3 when available', () => {
  const script = buildNotifySh(DATA_DIR);

  assert.match(script, /codex-notify-original\.json/);
  assert.match(script, /\[ "\$source" = "codex" \]/);
  assert.match(script, /python3/);
  assert.match(script, /notify\.mjs/);
});

test('buildHookCommand uses bash and quotes paths with spaces', () => {
  if (process.platform === 'win32') {
    const cmd = buildHookCommand('C:\\Users\\test\\my notify\\notify.cmd', 'claude');
    assert.match(cmd, /notify\.cmd/);
    assert.match(cmd, /--source=claude/);
    assert.doesNotMatch(cmd, /\bnode\b/);
    // Claude Code runs hooks via Git Bash on Windows, which strips backslashes.
    assert.equal(cmd, '"C:/Users/test/my notify/notify.cmd" --source=claude');
  } else {
    const cmd = buildHookCommand('/tmp/my notify/notify.sh', 'claude');
    assert.match(cmd, /\/bin\/bash/);
    assert.match(cmd, /notify\.sh/);
    assert.match(cmd, /--source=claude/);
    assert.doesNotMatch(cmd, /\bnode\b/);
    assert.match(cmd, /'\/tmp\/my notify\/notify\.sh'/);
  }
});

test('notifyScriptPath is platform-native (no .mjs)', () => {
  const path = notifyScriptPath(DATA_DIR);
  if (process.platform === 'win32') {
    assert.ok(path.endsWith('notify.cmd'));
  } else {
    assert.ok(path.endsWith('notify.sh'));
  }
  assert.doesNotMatch(path, /\.mjs$/);
});

test('writeNotifyScript creates executable sh that writes notify.signal', async () => {
  if (process.platform === 'win32') return;

  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-notify-'));
  const notifyPath = await writeNotifyScript(dir);
  assert.ok(notifyPath.endsWith('notify.sh'));

  const body = await readFile(notifyPath, 'utf8');
  assert.ok(body.startsWith('#!/bin/bash'));

  execFileSync('/bin/bash', [notifyPath, '--source=claude'], {
    timeout: 5_000,
    stdio: 'ignore',
  });

  const signal = await readFile(join(dir, 'notify.signal'), 'utf8');
  const parsed = JSON.parse(signal);
  assert.equal(parsed.source, 'claude');
  assert.ok(typeof parsed.ts === 'string');
});

test('notify.sh recovers from legacy millisecond throttle stamps', async () => {
  if (process.platform === 'win32') return;

  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-notify-ms-'));
  const notifyPath = await writeNotifyScript(dir);
  // Simulate leftover notify.mjs stamp (ms) that previously permanently blocked signals.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'notify.throttle.claude'), '1785311383802', 'utf8');

  execFileSync('/bin/bash', [notifyPath, '--source=claude'], {
    timeout: 5_000,
    stdio: 'ignore',
  });

  const signal = await readFile(join(dir, 'notify.signal'), 'utf8');
  assert.equal(JSON.parse(signal).source, 'claude');
  const stamp = (await readFile(join(dir, 'notify.throttle.claude'), 'utf8')).trim();
  assert.ok(/^\d{10}$/.test(stamp), `expected seconds stamp, got ${stamp}`);
});

test('writeNotifyScript clears stale throttle files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-notify-clear-'));
  const { writeFile, access } = await import('node:fs/promises');
  const throttle = join(dir, 'notify.throttle.claude');
  await writeFile(throttle, '1785311383802', 'utf8');
  await writeNotifyScript(dir);
  await assert.rejects(() => access(throttle));
});

test('buildNotifyScript matches platform', () => {
  const script = buildNotifyScript(DATA_DIR);
  if (process.platform === 'win32') {
    assert.match(script, /@echo off/i);
    assert.match(script, /notify\.ps1/);
  } else {
    assert.ok(script.startsWith('#!/bin/bash'));
  }
});

test('path helpers for sync signals and logs', () => {
  assert.equal(syncDonePath(DATA_DIR), join(DATA_DIR, 'sync.done'));
  assert.equal(notifyLogPath(DATA_DIR), join(DATA_DIR, 'logs', 'notify.log'));
  assert.equal(syncLogPath(DATA_DIR), join(DATA_DIR, 'logs', 'sync.log'));
  assert.deepEqual(syncSignalFilenames(), ['sync.done', 'notify.signal']);
  assert.equal(isSyncSignalFile('sync.done'), true);
  assert.equal(isSyncSignalFile('config.json'), false);
});

test('appendJsonLog appends JSONL and rotates at max size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-log-'));
  const logPath = join(dir, 'test.log');

  await appendJsonLog(logPath, { event: 'one' });
  await appendJsonLog(logPath, { event: 'two' });

  const text = await readFile(logPath, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).event, 'one');
  assert.equal(JSON.parse(lines[1]!).event, 'two');

  const bigLine = 'x'.repeat(LOG_MAX_BYTES);
  await appendJsonLog(logPath, { event: 'big', pad: bigLine });
  const st = await stat(logPath);
  assert.ok(st.size < LOG_MAX_BYTES * 2);
});

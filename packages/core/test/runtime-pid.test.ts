import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  argsMatchRuntimeKind,
  claimRuntimeOwner,
  clearPid,
  getRunningOwner,
  getRunningPid,
  parseRuntimeOwner,
  pidFilePath,
  readProcessArgs,
  readProcessStart,
  releaseRuntimeOwner,
  stopPid,
  writePid,
  writeRuntimeOwner,
} from '../src/runtime-pid.js';
import {
  HEARTBEAT_STALE_MS,
  isHeartbeatFresh,
  readRuntimeHeartbeat,
  touchRuntimeHeartbeat,
} from '../src/runtime-supervisor.js';

test('parseRuntimeOwner accepts JSON and legacy plain pid', () => {
  assert.deepEqual(parseRuntimeOwner('{"pid":42,"kind":"desktop"}'), {
    pid: 42,
    kind: 'desktop',
  });
  assert.deepEqual(
    parseRuntimeOwner('{"pid":42,"kind":"desktop","startedAt":"Thu Aug 13 20:04:12 2026"}'),
    {
      pid: 42,
      kind: 'desktop',
      startedAt: 'Thu Aug 13 20:04:12 2026',
    },
  );
  assert.deepEqual(parseRuntimeOwner('1234'), { pid: 1234, kind: 'cli' });
  assert.equal(parseRuntimeOwner(''), null);
  assert.equal(parseRuntimeOwner('{"pid":1,"kind":"web"}'), null);
});

test('claimRuntimeOwner becomes owner when no pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-pid-'));
  const claim = await claimRuntimeOwner(dir, {
    pid: process.pid,
    kind: 'cli',
  });
  assert.equal(claim.role, 'owner');
  if (claim.role === 'owner') {
    assert.equal(claim.pid, process.pid);
    assert.equal(claim.kind, 'cli');
  }
  const running = await getRunningOwner(dir);
  assert.equal(running?.pid, process.pid);
  assert.equal(running?.kind, 'cli');
  assert.ok(running?.startedAt);
  const parsed = JSON.parse(await readFile(pidFilePath(dir), 'utf8')) as {
    pid: number;
    kind: string;
    startedAt?: string;
  };
  assert.equal(parsed.pid, process.pid);
  assert.equal(parsed.kind, 'cli');
  assert.ok(parsed.startedAt);
  await releaseRuntimeOwner(dir, process.pid);
});

test('claimRuntimeOwner returns observer with owner kind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-pid-'));
  await writeRuntimeOwner({ pid: process.pid, kind: 'desktop' }, dir);
  const claim = await claimRuntimeOwner(dir, {
    pid: process.pid + 99999,
    kind: 'cli',
  });
  assert.equal(claim.role, 'observer');
  if (claim.role === 'observer') {
    assert.equal(claim.ownerPid, process.pid);
    assert.equal(claim.ownerKind, 'desktop');
  }
});

test('legacy leftover pid of an unrelated live process is cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-pid-'));
  await writeFile(pidFilePath(dir), `${process.pid}\n`, 'utf8');
  assert.equal(await getRunningOwner(dir), null);
  assert.equal(await getRunningPid(dir), null);
});

test('stale desktop pid without matching process is cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-pid-'));
  await writeFile(
    pidFilePath(dir),
    `${JSON.stringify({ pid: process.pid, kind: 'desktop' })}\n`,
    'utf8',
  );
  assert.equal(await getRunningOwner(dir), null);
});

test('readProcessStart uses C locale weekday/month names', () => {
  if (process.platform === 'win32') return;
  const start = readProcessStart(process.pid);
  assert.ok(start);
  assert.match(
    start,
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
  );
});

test('startedAt mismatch is treated as PID reuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-pid-'));
  await writeFile(
    pidFilePath(dir),
    `${JSON.stringify({
      pid: process.pid,
      kind: 'cli',
      startedAt: 'not-the-real-start-stamp',
    })}\n`,
    'utf8',
  );
  assert.equal(await getRunningOwner(dir), null);
});

test('releaseRuntimeOwner only clears own pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-pid-'));
  await writePid(process.pid, dir, 'desktop');
  await releaseRuntimeOwner(dir, process.pid + 1);
  assert.equal(await getRunningPid(dir), process.pid);
  await releaseRuntimeOwner(dir, process.pid);
  assert.equal(await getRunningPid(dir), null);
  await clearPid(dir);
});

test('argsMatchRuntimeKind recognizes CLI and desktop commands', () => {
  assert.equal(
    argsMatchRuntimeKind('node /Users/me/ai-usage/packages/cli/bin/jusage.js start', 'cli'),
    true,
  );
  assert.equal(
    argsMatchRuntimeKind(
      'node /Users/me/Library/Application Support/fnm/node-versions/v24.13.0/installation/lib/node_modules/@juejin-opensource/jusage/bin/jusage.js start',
      'cli',
    ),
    true,
  );
  assert.equal(
    argsMatchRuntimeKind(
      'node /Users/me/ai-usage/node_modules/@juejin-opensource/jusage-desktop/out/main/index.js',
      'cli',
    ),
    false,
  );
  assert.equal(
    argsMatchRuntimeKind(
      'node /Users/me/ai-usage/node_modules/electron-vite/bin/electron-vite.js dev',
      'desktop',
    ),
    false,
  );
  assert.equal(argsMatchRuntimeKind('/Applications/Juejin Usage.app/Contents/MacOS/Juejin Usage', 'desktop'), true);
  assert.equal(argsMatchRuntimeKind('/usr/sbin/cfprefsd', 'desktop'), false);
  assert.equal(argsMatchRuntimeKind('/usr/sbin/cfprefsd', 'cli'), false);
});

test('stopPid refuses to signal the current process', async () => {
  assert.equal(await stopPid(process.pid), false);
  assert.equal(await stopPid(0), true);
});

test('claimRuntimeOwner force takes over a live owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-pid-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  assert.ok(child.pid);
  await writeRuntimeOwner({ pid: child.pid, kind: 'cli' }, dir);
  const claim = await claimRuntimeOwner(dir, {
    pid: process.pid,
    kind: 'desktop',
    force: true,
  });
  assert.equal(claim.role, 'owner');
  if (claim.role === 'owner') {
    assert.equal(claim.kind, 'desktop');
    assert.equal(claim.pid, process.pid);
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      process.kill(child.pid!, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      break;
    }
  }
  try {
    process.kill(child.pid!, 0);
    assert.fail('child process should have been stopped');
  } catch {
    // expected
  }
  await releaseRuntimeOwner(dir, process.pid);
});

test('heartbeat freshness expires after stale window or dead pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-hb-'));
  await touchRuntimeHeartbeat({ pid: process.pid, kind: 'desktop' }, dir);
  const fresh = await readRuntimeHeartbeat(dir);
  assert.ok(fresh);
  assert.equal(isHeartbeatFresh(fresh), true);
  assert.equal(
    isHeartbeatFresh(fresh, (fresh?.at ?? 0) + HEARTBEAT_STALE_MS + 1),
    false,
  );
  assert.equal(
    isHeartbeatFresh({ pid: 999_999_999, kind: 'desktop', at: Date.now() }),
    false,
  );
});

test('readProcessStart and readProcessArgs can inspect the running process', () => {
  // Guards the platform probes themselves. On Windows these shell out, and the
  // tool they used (`wmic`) no longer ships with Windows 11 / Server 2025 — the
  // probes then returned null for every pid and isStillSameRuntimeProcess
  // rejected every recorded owner, so nothing could hold the runtime lock.
  const start = readProcessStart(process.pid);
  const args = readProcessArgs(process.pid);
  assert.ok(start, `readProcessStart(${process.pid}) returned ${String(start)}`);
  assert.ok(args, `readProcessArgs(${process.pid}) returned ${String(args)}`);
});

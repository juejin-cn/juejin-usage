import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSyncWorkerController } from './sync-worker-controller.js';
import type { SyncWorkerRequest } from './sync-worker-protocol.js';

class FakeWorker extends EventEmitter {
  messages: SyncWorkerRequest[] = [];
  killed = false;
  failPost = false;
  exitOnKill = true;
  killResult = true;
  forceKilled = false;
  exitOnForceKill = true;

  postMessage(message: SyncWorkerRequest): void {
    if (this.failPost) throw new Error('IPC closed');
    this.messages.push(message);
  }

  kill(): boolean {
    this.killed = true;
    if (this.exitOnKill && this.killResult) this.emit('exit', 0);
    return this.killResult;
  }
  ready(): void { this.emit('message', { type: 'ready' }); }
  complete(): void {
    const request = [...this.messages].reverse().find(message => message.type === 'runSync');
    assert(request?.type === 'runSync');
    this.emit('message', { type: 'syncDone', id: request.id, results: [] });
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function fixture() {
  const workers: FakeWorker[] = [];
  let failFork = false;
  let attempts = 0;
  const controller = createSyncWorkerController({
    fork: () => {
      attempts++;
      if (failFork) throw new Error('fork failed');
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    forceKill: worker => {
      const fake = worker as FakeWorker;
      fake.forceKilled = true;
      if (fake.exitOnForceKill) fake.emit('exit', 1);
    },
    startTimeoutMs: 100,
    syncTimeoutMs: 1_000,
    restartDelayMs: 10,
    maxAutomaticRestarts: 2,
    terminateTimeoutMs: 50,
  });
  return {
    controller, workers,
    failFork: (value: boolean) => { failFork = value; },
    attempts: () => attempts,
  };
}

test('a failed restart retains the data directory and later retries collect every source', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const started = f.controller.start('/usage');
  f.workers[0]!.ready();
  assert.equal(await started, true);
  assert.equal(f.controller.getGeneration(), 1);
  f.failFork(true);
  f.workers[0]!.emit('exit', 1);
  t.mock.timers.tick(10);
  await flush();
  assert.equal(f.attempts(), 2);
  f.failFork(false);
  t.mock.timers.tick(20);
  await flush();
  const replacement = f.workers[1]!;
  replacement.ready();
  assert.equal(f.controller.getGeneration(), 2);
  const sync = f.controller.runSync('notify.signal', 'codex');
  await flush();
  assert.deepEqual(replacement.messages[0], { type: 'init', dataDir: '/usage' });
  const request = replacement.messages.find(message => message.type === 'runSync');
  assert.equal(request?.source, undefined);
  replacement.complete();
  await sync;
  const next = f.controller.runSync('notify.signal', 'codex');
  await flush();
  assert.equal(replacement.messages.at(-1)?.type, 'runSync');
  assert.equal((replacement.messages.at(-1) as { source?: string }).source, 'codex');
  replacement.complete();
  await next;
});

test('concurrent starts and sync requests share one worker and one request', async (t) => {
  const f = fixture();
  t.after(() => f.controller.stop());
  const first = f.controller.start('/usage');
  assert.equal(f.controller.start('/usage'), first);
  const sync = f.controller.runSync('poll');
  assert.equal(f.controller.runSync('notify.signal', 'codex'), sync);
  f.workers[0]!.ready();
  assert.equal(await first, true);
  await flush();
  assert.equal(f.attempts(), 1);
  assert.equal(f.workers[0]!.messages.filter(message => message.type === 'runSync').length, 1);
  f.workers[0]!.complete();
  await sync;
});

test('exit before ready finishes startup immediately and a late old exit cannot affect its replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const first = f.controller.start('/usage');
  const old = f.workers[0]!;
  assert.equal(f.controller.getGeneration(), 0);
  old.emit('exit', 1);
  assert.equal(await first, false);
  t.mock.timers.tick(10);
  const fresh = f.workers[1]!;
  fresh.ready();
  assert.equal(f.controller.getGeneration(), 1);
  const sync = f.controller.runSync('poll');
  await flush();
  old.emit('message', { type: 'ready' });
  old.emit('message', { type: 'syncError', id: 1, error: 'old worker' });
  old.emit('exit', 1);
  fresh.ready();
  assert.equal(f.controller.getGeneration(), 1);
  assert.equal(f.controller.isRunning(), true);
  fresh.complete();
  await sync;
});

test('stop during startup cancels timers and late ready cannot resurrect the worker', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const startup = f.controller.start('/usage');
  const sync = f.controller.runSync('poll');
  const rejected = assert.rejects(sync, /not running|stopped/);
  f.controller.stop();
  f.workers[0]!.ready();
  f.workers[0]!.emit('exit', 1);
  assert.equal(await startup, false);
  await rejected;
  t.mock.timers.tick(10_000);
  assert.equal(f.attempts(), 1);
  assert.equal(f.controller.isRunning(), false);
});

test('sync timeout terminates the unresponsive worker and recovery uses a fresh worker', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const startup = f.controller.start('/usage');
  f.workers[0]!.ready();
  await startup;
  const sync = f.controller.runSync('poll');
  const rejected = assert.rejects(sync, /timed out/);
  await flush();
  t.mock.timers.tick(1_000);
  await rejected;
  assert.equal(f.workers[0]!.killed, true);
  t.mock.timers.tick(10);
  f.workers[1]!.ready();
  const recovered = f.controller.runSync('recovery');
  await flush();
  f.workers[1]!.complete();
  await recovered;
});

test('ready timeout and IPC failure clean up their worker and permit retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const startup = f.controller.start('/usage');
  t.mock.timers.tick(100);
  assert.equal(await startup, false);
  assert.equal(f.workers[0]!.killed, true);
  t.mock.timers.tick(10);
  f.workers[1]!.ready();
  f.workers[1]!.failPost = true;
  await assert.rejects(f.controller.runSync('poll'), /IPC closed/);
  assert.equal(f.workers[1]!.killed, true);
});

test('automatic restarts are bounded but later polls can still retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  f.failFork(true);
  assert.equal(await f.controller.start('/usage'), false);
  t.mock.timers.tick(10);
  await flush();
  t.mock.timers.tick(20);
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.attempts(), 3);
  f.failFork(false);
  const sync = f.controller.runSync('poll');
  f.workers[0]!.ready();
  await flush();
  f.workers[0]!.complete();
  await sync;
});

test('exit during a sync rejects it immediately and stopping cancels the scheduled restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  const startup = f.controller.start('/usage');
  f.workers[0]!.ready();
  await startup;
  const sync = f.controller.runSync('poll');
  const rejected = assert.rejects(sync, /exited \(1\)/);
  await flush();
  f.workers[0]!.emit('exit', 1);
  await rejected;
  f.controller.stop();
  t.mock.timers.tick(60_000);
  assert.equal(f.attempts(), 1);
});

test('a stopped startup cannot resume its sync against a newly started worker', async (t) => {
  const f = fixture();
  t.after(() => f.controller.stop());
  const oldStart = f.controller.start('/old');
  const oldSync = f.controller.runSync('poll');
  const rejected = assert.rejects(oldSync, /not running/);
  f.controller.stop();
  const newStart = f.controller.start('/new');
  const newSync = f.controller.runSync('recovery');
  f.workers[1]!.ready();
  assert.equal(await oldStart, false);
  assert.equal(await newStart, true);
  await rejected;
  await flush();
  assert.equal(f.workers[1]!.messages.filter(message => message.type === 'runSync').length, 1);
  assert.equal(f.controller.runSync('poll'), newSync);
  f.workers[1]!.complete();
  await newSync;
});

test('ready without a completed sync does not reset the crash retry limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const startup = f.controller.start('/usage');
  f.workers[0]!.ready();
  await startup;
  f.workers[0]!.emit('exit', 1);
  t.mock.timers.tick(10);
  f.workers[1]!.ready();
  f.workers[1]!.emit('exit', 1);
  t.mock.timers.tick(20);
  f.workers[2]!.ready();
  f.workers[2]!.emit('exit', 1);
  t.mock.timers.tick(60_000);
  assert.equal(f.attempts(), 3);
});

test('a delayed SIGTERM exit reserves the writer slot until exit is confirmed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const startup = f.controller.start('/usage');
  const old = f.workers[0]!;
  old.ready();
  old.exitOnKill = false;
  await startup;
  const sync = f.controller.runSync('poll');
  const rejected = assert.rejects(sync, /timed out/);
  await flush();
  t.mock.timers.tick(1_000);
  await rejected;
  t.mock.timers.tick(10);
  assert.equal(f.attempts(), 1);
  assert.equal(await f.controller.start('/usage'), false);
  assert.equal(old.forceKilled, false);
  old.emit('exit', 0);
  t.mock.timers.tick(1);
  assert.equal(f.attempts(), 2);
  f.workers[1]!.ready();
});

test('a failed SIGTERM escalates immediately but an unconfirmed SIGKILL cannot allow another writer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const startup = f.controller.start('/usage');
  const old = f.workers[0]!;
  old.killResult = false;
  old.exitOnForceKill = false;
  t.mock.timers.tick(100);
  assert.equal(await startup, false);
  assert.equal(old.forceKilled, true);
  t.mock.timers.tick(60_000);
  assert.equal(await f.controller.start('/usage'), false);
  assert.equal(f.attempts(), 1);
  old.emit('exit', 1);
  t.mock.timers.tick(1);
  assert.equal(f.attempts(), 2);
  f.workers[1]!.ready();
});

test('SIGTERM timeout escalates to SIGKILL and restart follows its exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const startup = f.controller.start('/usage');
  const old = f.workers[0]!;
  old.exitOnKill = false;
  t.mock.timers.tick(100);
  assert.equal(await startup, false);
  t.mock.timers.tick(49);
  assert.equal(old.forceKilled, false);
  assert.equal(f.attempts(), 1);
  t.mock.timers.tick(1);
  assert.equal(old.forceKilled, true);
  assert.equal(f.attempts(), 2);
  f.workers[1]!.ready();
});

test('stop followed by start cannot bypass the retiring writer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  t.after(() => f.controller.stop());
  const startup = f.controller.start('/old');
  const old = f.workers[0]!;
  old.ready();
  await startup;
  old.exitOnKill = false;
  f.controller.stop();
  assert.equal(await f.controller.start('/new'), false);
  assert.equal(f.attempts(), 1);
  old.emit('exit', 0);
  t.mock.timers.tick(1);
  assert.equal(f.attempts(), 2);
  assert.deepEqual(f.workers[1]!.messages[0], { type: 'init', dataDir: '/new' });
  f.workers[1]!.ready();
});

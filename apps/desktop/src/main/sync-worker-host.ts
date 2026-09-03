/**
 * Host for the sync utilityProcess. Main process watches signals / timers
 * and applies deltas; parsers run in the child.
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import syncWorkerPath from './sync-worker?modulePath';

import type { SyncResult } from '@juejin-opensource/jusage-core';
import type { SyncWorkerRequest, SyncWorkerResponse } from './sync-worker-protocol';

const START_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 10 * 60_000;

let child: UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (results: SyncResult[]) => void; reject: (err: Error) => void }
>();
let ready = false;
let lastDataDir: string | null = null;
let stopping = false;
let ignoreNextExit = false;
let crashRestarts = 0;

function workerScriptPath(): string {
  return syncWorkerPath;
}

function rejectAll(err: Error): void {
  for (const [, waiter] of pending) waiter.reject(err);
  pending.clear();
}

function handleMessage(data: unknown): void {
  const msg = data as SyncWorkerResponse;
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
  if (msg.type === 'ready') {
    ready = true;
    return;
  }
  if (msg.type === 'syncDone') {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    waiter.resolve(msg.results);
    return;
  }
  if (msg.type === 'syncError') {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    waiter.reject(new Error(msg.error));
  }
}

export function isSyncWorkerRunning(): boolean {
  return child != null && ready;
}

function killChild(): void {
  const spawned = child;
  child = null;
  ready = false;
  rejectAll(new Error('sync worker stopped'));
  if (!spawned) return;
  ignoreNextExit = true;
  try {
    spawned.postMessage({ type: 'stop' } satisfies SyncWorkerRequest);
  } catch {
    // ignore
  }
  try {
    spawned.kill();
  } catch {
    // ignore
  }
}

export async function startSyncWorker(dataDir: string): Promise<boolean> {
  stopping = false;
  lastDataDir = dataDir;
  killChild();
  try {
    const spawned = utilityProcess.fork(workerScriptPath(), [], {
      serviceName: 'Juejin Usage Sync',
      stdio: 'pipe',
    });
    child = spawned;
    ready = false;

    spawned.stdout?.on('data', (buf: Buffer) => {
      process.stdout.write(`[tud-sync-worker] ${buf.toString()}`);
    });
    spawned.stderr?.on('data', (buf: Buffer) => {
      process.stderr.write(`[tud-sync-worker] ${buf.toString()}`);
    });
    spawned.on('message', (data) => {
      handleMessage(data);
    });
    spawned.on('exit', (code) => {
      const expected = ignoreNextExit;
      ignoreNextExit = false;
      const err = new Error(`sync worker exited (${code ?? 'null'})`);
      rejectAll(err);
      if (child === spawned) {
        child = null;
        ready = false;
      }
      if (!expected && !stopping && lastDataDir && crashRestarts < 5) {
        crashRestarts += 1;
        const dir = lastDataDir;
        setTimeout(() => {
          if (!stopping && lastDataDir === dir && !ready) {
            void startSyncWorker(dir);
          }
        }, 500);
      }
    });

    const waitReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        spawned.removeListener('message', onMessage);
        reject(new Error('sync worker ready timeout'));
      }, START_TIMEOUT_MS);
      const onMessage = (data: unknown) => {
        const msg = data as SyncWorkerResponse;
        if (msg && msg.type === 'ready') {
          clearTimeout(timer);
          spawned.removeListener('message', onMessage);
          resolve();
        }
      };
      spawned.on('message', onMessage);
    });

    spawned.postMessage({ type: 'init', dataDir } satisfies SyncWorkerRequest);
    await waitReady;
    ready = true;
    crashRestarts = 0;
    console.log(
      `[tud-desktop] sync utilityProcess ready pid=${spawned.pid ?? '?'}`,
    );
    return true;
  } catch (err) {
    console.warn(
      '[tud-desktop] sync utilityProcess failed to start, falling back to in-process:',
      err instanceof Error ? err.message : err,
    );
    killChild();
    lastDataDir = null;
    return false;
  }
}

export function stopSyncWorker(): void {
  stopping = true;
  lastDataDir = null;
  killChild();
}

export async function runSyncViaWorker(
  reason: string,
  source?: string,
): Promise<SyncResult[]> {
  if (!child || !ready) {
    if (lastDataDir) {
      const ok = await startSyncWorker(lastDataDir);
      if (!ok) throw new Error('sync worker is not running');
    } else {
      throw new Error('sync worker is not running');
    }
  }
  const id = nextId++;
  return new Promise<SyncResult[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`sync worker timed out after ${SYNC_TIMEOUT_MS}ms`));
    }, SYNC_TIMEOUT_MS);
    pending.set(id, {
      resolve: (results) => {
        clearTimeout(timer);
        resolve(results);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    child!.postMessage({
      type: 'runSync',
      id,
      reason,
      source,
    } satisfies SyncWorkerRequest);
  });
}

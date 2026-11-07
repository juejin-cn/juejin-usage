import type { SyncResult } from '@juejin-opensource/jusage-core';
import type { SyncWorkerRequest, SyncWorkerResponse } from './sync-worker-protocol.js';

export interface SyncWorkerProcess {
  readonly pid?: number;
  postMessage(message: SyncWorkerRequest): void;
  kill(): boolean | void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

interface WorkerState {
  process: SyncWorkerProcess;
  ready: boolean;
  needsCatchup: boolean;
  finishStart: (ready: boolean) => void;
}

/** Own one worker generation; only that generation may settle its requests. */
export function createSyncWorkerController(options: {
  fork: () => SyncWorkerProcess;
  forceKill: (worker: SyncWorkerProcess) => void;
  log?: (dataDir: string, entry: Record<string, unknown>) => void;
  startTimeoutMs?: number;
  syncTimeoutMs?: number;
  restartDelayMs?: number;
  maxAutomaticRestarts?: number;
  terminateTimeoutMs?: number;
}) {
  const startTimeoutMs = options.startTimeoutMs ?? 15_000;
  const syncTimeoutMs = options.syncTimeoutMs ?? 10 * 60_000;
  const restartDelayMs = options.restartDelayMs ?? 500;
  const maxAutomaticRestarts = options.maxAutomaticRestarts ?? 5;
  const terminateTimeoutMs = options.terminateTimeoutMs ?? 5_000;
  let dataDir: string | null = null;
  let worker: WorkerState | null = null;
  let retiring: { worker: WorkerState; timer?: ReturnType<typeof setTimeout> } | null = null;
  let generation = 0;
  let readyGeneration = 0;
  let nextId = 1;
  let failures = 0;
  let retryAt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let starting: Promise<boolean> | null = null;
  let syncing: Promise<SyncResult[]> | null = null;
  let pending: {
    id: number;
    resolve: (results: SyncResult[]) => void;
    reject: (error: Error) => void;
  } | null = null;

  function log(event: string, detail: Record<string, unknown> = {}): void {
    if (dataDir) options.log?.(dataDir, { event, ...detail });
  }

  function scheduleRestart(countFailure = true): void {
    if (!dataDir || restartTimer) return;
    if (countFailure) {
      failures++;
      retryAt = Date.now() + Math.min(restartDelayMs * 2 ** Math.min(failures - 1, 6), 30_000);
    }
    const delay = Math.max(0, retryAt - Date.now());
    if (failures > maxAutomaticRestarts) {
      log('sync_worker_retry_deferred', { failures, delayMs: delay });
      return;
    }
    log('sync_worker_restart_scheduled', { failures, delayMs: delay });
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (dataDir && !worker) void start(dataDir);
    }, delay);
  }

  function discard(current: WorkerState, error: Error, kill: boolean): void {
    if (worker !== current) return;
    worker = null;
    current.finishStart(false);
    pending?.reject(error);
    pending = null;
    if (kill) {
      // SIGTERM delivery is not proof of exit. Keep the writer slot reserved
      // until Electron confirms termination, including across stop/start.
      const retired = { worker: current, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      retiring = retired;
      const forceKill = () => {
        if (retiring !== retired) return;
        clearTimeout(retired.timer);
        log('sync_worker_force_kill', { pid: current.process.pid });
        try { options.forceKill(current.process); } catch (error) {
          log('sync_worker_force_kill_failed', { error: String(error), pid: current.process.pid });
        }
        if (retiring === retired) {
          retired.timer = setTimeout(() => {
            log('sync_worker_exit_unconfirmed', { pid: current.process.pid });
          }, terminateTimeoutMs);
        }
      };
      retired.timer = setTimeout(forceKill, terminateTimeoutMs);
      try {
        if (current.process.kill() === false) forceKill();
      } catch {
        forceKill();
      }
    }
  }

  function failed(current: WorkerState, error: Error, kill = true): void {
    if (worker !== current) return;
    log('sync_worker_failed', { pid: current.process.pid, error: error.message });
    scheduleRestart();
    discard(current, error, kill);
  }

  function start(dir: string): Promise<boolean> {
    if (dataDir && dataDir !== dir) stop();
    dataDir = dir;
    if (retiring) return Promise.resolve(false);
    if (worker?.ready) return Promise.resolve(true);
    if (starting) return starting;
    if (Date.now() < retryAt) return Promise.resolve(false);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;

    let resolve!: (ready: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    starting = promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finishStart = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (starting === promise) starting = null;
      resolve(ready);
    };

    try {
      const current: WorkerState = {
        process: options.fork(), ready: false, needsCatchup: true, finishStart,
      };
      worker = current;
      current.process.on('message', (data: unknown) => {
        if (worker !== current || !data || typeof data !== 'object') return;
        const message = data as SyncWorkerResponse;
        if (message.type === 'ready') {
          if (current.ready) return;
          current.ready = true;
          readyGeneration++;
          finishStart(true);
          log('sync_worker_ready', {
            pid: current.process.pid, generation: readyGeneration, recovering: failures > 0,
          });
        } else if ((message.type === 'syncDone' || message.type === 'syncError') &&
          pending?.id === message.id) {
          const request = pending;
          pending = null;
          // A ready message alone must not reset repeated crash protection.
          failures = 0;
          retryAt = 0;
          if (message.type === 'syncDone') {
            current.needsCatchup = false;
            request.resolve(message.results);
          } else {
            log('sync_worker_sync_error', { pid: current.process.pid, error: message.error });
            request.reject(new Error(message.error));
          }
        }
      });
      current.process.on('exit', code => {
        if (retiring?.worker === current) {
          clearTimeout(retiring.timer);
          retiring = null;
          scheduleRestart(false);
          return;
        }
        failed(current, new Error(`sync worker exited (${code ?? 'null'})`), false);
      });
      timer = setTimeout(() => {
        failed(current, new Error('sync worker ready timeout'));
      }, startTimeoutMs);
      current.process.postMessage({ type: 'init', dataDir: dir });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (worker) failed(worker, err);
      else {
        finishStart(false);
        log('sync_worker_start_failed', { error: err.message });
        scheduleRestart();
      }
    }
    return promise;
  }

  function stop(): void {
    generation++;
    dataDir = null;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
    failures = 0;
    retryAt = 0;
    if (worker) discard(worker, new Error('sync worker stopped'), true);
    starting = null;
    syncing = null;
  }

  function runSync(reason: string, source?: string): Promise<SyncResult[]> {
    if (syncing) return syncing;
    const epoch = generation;
    const operation = (async () => {
      if (!dataDir || !await start(dataDir) || epoch !== generation || !worker?.ready) {
        throw new Error('sync worker is not running');
      }
      const current = worker;
      const id = nextId++;
      return new Promise<SyncResult[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          failed(current, new Error(`sync worker timed out after ${syncTimeoutMs}ms`));
        }, syncTimeoutMs);
        pending = {
          id,
          resolve: results => { clearTimeout(timer); resolve(results); },
          reject: error => { clearTimeout(timer); reject(error); },
        };
        try {
          // Persisted parser cursors cover all missed days; a hook must not
          // restrict the first round after a restart to just its own source.
          current.process.postMessage({
            type: 'runSync', id, reason,
            source: current.needsCatchup ? undefined : source,
          });
        } catch (error) {
          failed(current, error instanceof Error ? error : new Error(String(error)));
        }
      });
    })();
    const result = operation.finally(() => {
      if (syncing === result) syncing = null;
    });
    syncing = result;
    return result;
  }

  function invalidateCursors(): void {
    if (!worker?.ready) return;
    try {
      worker.process.postMessage({ type: 'invalidateCursors' });
    } catch (error) {
      failed(worker, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    start, stop, runSync, invalidateCursors,
    isRunning: () => worker?.ready === true,
    getGeneration: () => readyGeneration,
  };
}

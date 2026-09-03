/**
 * Electron utilityProcess entry: parsers / sync / upload live here so the
 * main process event loop (IPC + window) is not blocked by JSONL / SQLite.
 */
import {
  appendJsonLog,
  createSyncRunner,
  kickBackfillDrain,
  loadConfig,
  stopBackfillDrain,
  syncLogPath,
  type SyncResult,
  type TudConfig,
} from '@juejin-opensource/jusage-core';
import type { SyncWorkerRequest, SyncWorkerResponse } from './sync-worker-protocol';

process.title = 'tud-sync-worker';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  process.stderr.write('[tud-sync-worker] missing process.parentPort; exiting\n');
  process.exit(1);
}

let runSyncFn: ((reason: string, source?: string) => Promise<SyncResult[]>) | null = null;
let config: TudConfig | null = null;
let dataDir = '';

function post(msg: SyncWorkerResponse): void {
  parentPort!.postMessage(msg);
}

parentPort.on('message', (event) => {
  void handle(event.data as SyncWorkerRequest);
});

async function handle(msg: SyncWorkerRequest): Promise<void> {
  if (msg.type === 'init') {
    dataDir = msg.dataDir;
    const loaded = await loadConfig(dataDir);
    config = loaded.config;
    const { runSync } = createSyncRunner({
      dataDir,
      getConfig: () => config!,
      setConfig: (next) => {
        config = next;
      },
      loadConfig,
    });
    runSyncFn = runSync;
    kickBackfillDrain(dataDir, () => config!);
    await appendJsonLog(syncLogPath(dataDir), {
      event: 'cpu_phase',
      phase: 'worker_ready',
      pid: process.pid,
      role: 'sync-worker',
      wallMs: 0,
      cpuMs: 0,
    });
    process.stdout.write(`[tud-sync-worker] ready pid=${process.pid}\n`);
    post({ type: 'ready', pid: process.pid });
    return;
  }

  if (msg.type === 'stop') {
    stopBackfillDrain();
    runSyncFn = null;
    return;
  }

  if (msg.type === 'runSync') {
    if (!runSyncFn) {
      post({ type: 'syncError', id: msg.id, error: 'sync worker not initialized' });
      return;
    }
    try {
      const results = await runSyncFn(msg.reason, msg.source);
      post({ type: 'syncDone', id: msg.id, results });
    } catch (err) {
      post({
        type: 'syncError',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

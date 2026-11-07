/** Electron adapter; worker lifetime and recovery are tested without Electron. */
import { utilityProcess } from 'electron';
import { appendJsonLog, syncLogPath } from '@juejin-opensource/jusage-core';
import syncWorkerPath from './sync-worker?modulePath';
import { createSyncWorkerController } from './sync-worker-controller';

const controller = createSyncWorkerController({
  fork: () => {
    const child = utilityProcess.fork(syncWorkerPath, [], {
      serviceName: 'Juejin Usage Sync',
      stdio: 'pipe',
    });
    child.stdout?.on('data', (buf: Buffer) => {
      process.stdout.write(`[tud-sync-worker] ${buf.toString()}`);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      process.stderr.write(`[tud-sync-worker] ${buf.toString()}`);
    });
    return child;
  },
  forceKill: child => {
    if (child.pid != null) process.kill(child.pid, 'SIGKILL');
  },
  log: (dataDir, entry) => {
    void appendJsonLog(syncLogPath(dataDir), { ...entry, role: 'main', mainPid: process.pid });
  },
});

export const startSyncWorker = controller.start;
export const stopSyncWorker = controller.stop;
export const isSyncWorkerRunning = controller.isRunning;
export const getSyncWorkerGeneration = controller.getGeneration;
export const runSyncViaWorker = controller.runSync;
export const invalidateSyncWorkerCursors = controller.invalidateCursors;

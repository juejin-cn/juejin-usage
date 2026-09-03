import { readFile } from 'node:fs/promises';

import { appendJsonLog, measureCpuPhase } from '../debug-log.js';
import { notifySignalPath, syncLogPath } from '../paths.js';
import { writeSyncDone } from '../signals.js';
import {
  collectWrittenBuckets,
  syncAll,
  syncAllStaggered,
  type SyncResult,
} from '../sync/index.js';
import type { TudConfig } from '../types.js';
import { maybeUploadAfterSync } from '../upload/client.js';
import { watchSyncSignals } from './sync-watcher.js';

export type SyncSignalName = 'notify.signal' | 'sync.done';

export type SyncAllFn = (
  dataDir: string,
  config: TudConfig,
  source?: string,
) => Promise<SyncResult[]>;

export interface SignalSyncDeps {
  dataDir: string;
  getConfig: () => TudConfig;
  setConfig?: (config: TudConfig) => void;
  /** Apply the completed sync's changes to BucketStore and notify the UI. */
  refreshFromDisk: (
    results?: SyncResult[],
    opts?: { quiet?: boolean; forceNotify?: boolean },
  ) => void | Promise<void>;
  /** When true, notify.signal triggers sync+upload. Observer mode ignores notify. */
  isOwner: () => boolean;
  loadConfig: (dataDir?: string) => Promise<{ dir: string; config: TudConfig }>;
  /** Test seam; defaults to syncAll. */
  syncAllFn?: SyncAllFn;
  /**
   * Desktop: run sync in a utility process. When set, createSyncRunner is
   * not used in this process; the caller is responsible for applying results.
   */
  runSyncOverride?: (reason: string, source?: string) => Promise<SyncResult[]>;
}

/**
 * Read optional `source` from notify.signal JSON payload.
 * Missing / invalid file → undefined (full sync).
 */
export async function readNotifySignalSource(
  dataDir: string,
): Promise<string | undefined> {
  try {
    const raw = (await readFile(notifySignalPath(dataDir), 'utf8')).trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { source?: unknown };
    if (typeof parsed.source !== 'string') return undefined;
    const source = parsed.source.trim();
    return source || undefined;
  } catch {
    return undefined;
  }
}

function shouldStagger(reason: string, source?: string): boolean {
  if (source) return false;
  return reason === 'poll' || reason === 'startup';
}

/**
 * Shared in-flight guard so poll + notify cannot overlap sync/upload.
 * Optional `source` scopes syncAll (e.g. hook notify for one channel).
 *
 * poll / startup (no source): staggered one-channel-at-a-time with 1s gaps.
 * manual / notify / ensure: fast syncAll.
 */
export function createSyncRunner(deps: {
  dataDir: string;
  getConfig: () => TudConfig;
  setConfig?: (config: TudConfig) => void;
  loadConfig: (dataDir?: string) => Promise<{ dir: string; config: TudConfig }>;
  afterSync?: (
    results: SyncResult[],
    opts?: { quiet?: boolean; forceNotify?: boolean },
  ) => void | Promise<void>;
  /** Fired once after a staggered round so UI can refresh without 30 notifies. */
  onRoundComplete?: (wroteAny: boolean) => void | Promise<void>;
  syncAllFn?: SyncAllFn;
}): {
  runSync: (reason: string, source?: string) => Promise<SyncResult[]>;
  isBusy: () => boolean;
} {
  let inFlight: Promise<SyncResult[]> | null = null;
  const runSyncAll = deps.syncAllFn ?? syncAll;

  const runSync = async (
    reason: string,
    source?: string,
  ): Promise<SyncResult[]> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const logPath = syncLogPath(deps.dataDir);
      const started = Date.now();
      const staggered = shouldStagger(reason, source);
      await appendJsonLog(logPath, {
        event: 'signal_sync_start',
        reason,
        staggered,
        pid: process.pid,
        role: process.title === 'tud-sync-worker' ? 'sync-worker' : 'main',
        ...(source ? { source } : {}),
      });
      try {
        const { config: cfg } = await measureCpuPhase(
          logPath,
          'load_config',
          {},
          () => deps.loadConfig(deps.dataDir),
        );
        deps.setConfig?.(cfg);

        let results: SyncResult[];
        if (staggered && !deps.syncAllFn) {
          let wroteAny = false;
          results = await syncAllStaggered(deps.dataDir, cfg, {
            onSourceDone: async (result) => {
              await appendJsonLog(logPath, {
                event: 'signal_sync_source',
                reason,
                source: result.source,
                skipped: Boolean(result.skipped),
                bucketsWritten: result.bucketsWritten,
                ...(result.error ? { error: result.error } : {}),
              });
              if (result.writtenBuckets.length > 0) wroteAny = true;
              // Apply quietly — one UI notify at end of the round if anything changed.
              if (deps.afterSync) {
                await measureCpuPhase(
                  logPath,
                  'after_sync',
                  { source: result.source, quiet: true },
                  () => deps.afterSync?.([result], { quiet: true }),
                );
              }
            },
          });
          await deps.onRoundComplete?.(wroteAny);
        } else {
          results = await runSyncAll(deps.dataDir, cfg, source);
          if (deps.afterSync) {
            await measureCpuPhase(logPath, 'after_sync', {}, () =>
              deps.afterSync?.(results),
            );
          }
        }

        await measureCpuPhase(logPath, 'upload', {}, () =>
          maybeUploadAfterSync(
            deps.dataDir,
            cfg,
            collectWrittenBuckets(results),
          ),
        );
        await writeSyncDone(deps.dataDir);
        const { config: nextCfg } = await deps.loadConfig(deps.dataDir);
        deps.setConfig?.(nextCfg);
        await appendJsonLog(logPath, {
          event: 'signal_sync_done',
          reason,
          staggered,
          pid: process.pid,
          role: process.title === 'tud-sync-worker' ? 'sync-worker' : 'main',
          ...(source ? { source } : {}),
          durationMs: Date.now() - started,
          sources: results.length,
          skipped: results.filter((r) => r.skipped).length,
          bucketsWritten: collectWrittenBuckets(results).length,
        });
        return results;
      } catch (err) {
        await appendJsonLog(logPath, {
          event: 'signal_sync_error',
          reason,
          ...(source ? { source } : {}),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    runSync,
    isBusy: () => inFlight != null,
  };
}

/**
 * Route filesystem signals: owner syncs on notify.signal; everyone refreshes on sync.done.
 * When notify.signal JSON includes `source`, only that channel is synced.
 */
export function watchRuntimeSignals(
  deps: SignalSyncDeps,
  debounceMs = 400,
): { stop: () => void; runSync: (reason: string, source?: string) => Promise<SyncResult[]> } {
  const runSync =
    deps.runSyncOverride ??
    createSyncRunner({
      dataDir: deps.dataDir,
      getConfig: deps.getConfig,
      setConfig: deps.setConfig,
      loadConfig: deps.loadConfig,
      afterSync: deps.refreshFromDisk,
      onRoundComplete: async (wroteAny) => {
        // Staggered poll already applied quietly; notify UI only when queue changed.
        if (!wroteAny) return;
        await deps.refreshFromDisk([], { forceNotify: true });
      },
      syncAllFn: deps.syncAllFn,
    }).runSync;

  const stop = watchSyncSignals(
    deps.dataDir,
    async (filename) => {
      if (filename === 'notify.signal') {
        if (!deps.isOwner()) return;
        try {
          const source = await readNotifySignalSource(deps.dataDir);
          await runSync('notify.signal', source);
        } catch {
          // logged inside runSync
        }
        return;
      }
      if (filename === 'sync.done') {
        // The owner has already applied this sync's result via `afterSync`.
        // Reacting to its own signal would reload every historical queue file.
        if (deps.isOwner()) return;
        await deps.refreshFromDisk();
      }
    },
    debounceMs,
  );

  return { stop, runSync };
}

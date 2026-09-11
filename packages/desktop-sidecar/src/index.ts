/**
 * jusage-desktop-sidecar — Node sidecar for the Tauri desktop client.
 *
 * The Tauri app bundles a Node runtime + this script and spawns it as a child
 * process (see apps/desktop-tauri/src-tauri/src/sidecar). It owns the local
 * Core runtime exactly like the Electron main process did:
 *
 *   - evict CLI autostart + evict the CLI runtime kind
 *   - claim the runtime owner as `kind: 'desktop'` (force), so the desktop
 *     client is the sync/upload owner (same semantics as apps/desktop)
 *   - wire hooks, pricing refresh, bucket store, aggregate cache,
 *     watchRuntimeSignals (in-process runSync — no separate utilityProcess)
 *   - serve the local-api over loopback HTTP (`/health` + `/functions/tud-*`)
 *
 * The Tauri webview fetches the local-api from this sidecar instead of the
 * Electron in-process IPC bridge.
 *
 * stdout contract (Rust reads these lines):
 *   PORT=<port>    emitted once, as the first line, with the bound port
 *   SYNCED         emitted after a data-affecting sync so the host can
 *                  broadcast `tud:data-synced` to the webviews
 *   RUNTIME_NOTICE=CONFIG_RESET:<true|false>
 *                  emitted at most once, when `loadConfig` had to recover from
 *                  a corrupt config; the host forwards it to the webviews as
 *                  `app:runtime-notice` (`tokenSalvaged` = whether the identity
 *                  was salvaged). Mirrors Electron's config-reset notice.
 *
 * This module intentionally mirrors `apps/desktop/src/main/local-runtime.ts`
 * `startLocalRuntimeUnlocked`, minus the sync-worker hop.
 */
import {
  createApplyAfterSync,
  createAggregateCache,
  createHttpServer,
  createLocalApiApp,
  createPollBackoff,
  getHookStatus,
  kickBackfillDrain,
  listenServer,
  loadConfig,
  POLL_INTERVAL_MS,
  releaseRuntimeOwner,
  resolveLocalCollectSince,
  setupClaudeHook,
  setupCodexHook,
  stopBackfillDrain,
  startPricingRefresh,
  resolvePricingRefreshConfig,
  DEFAULT_PRICING_FIRST_FETCH_TIMEOUT_MS,
  touchStatsSince,
  touchRuntimeHeartbeat,
  watchRuntimeSignals,
  evictRuntimeKind,
  claimRuntimeOwner,
  writeSyncDone,
  BucketStore,
  type AggregateCache,
  type SyncResult,
  type TudConfig,
} from '@juejin-opensource/jusage-core';
import { evictCliAutostart } from './evict-cli-autostart.js';

/** Desktop sidecar default port. CLI owns 8452, so we use 8462 to avoid conflict. */
const DEFAULT_DESKTOP_PORT = 8462;

let server: ReturnType<typeof createHttpServer> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pricingRefreshStop: (() => void) | null = null;
let syncWatcherStop: (() => void) | null = null;
let runSyncFn: ((reason: string, source?: string) => Promise<SyncResult[]>) | null = null;
let pollBackoff = createPollBackoff();
let reArmPoll: (() => void) | null = null;
let ownedDir: string | null = null;

let runtime: {
  dir: string;
  config: TudConfig;
  bucketStore: BucketStore;
  aggregateCache: AggregateCache;
} | null = null;

function announcePort(port: number): void {
  process.stdout.write(`PORT=${port}\n`);
}

/** Emit a data-synced marker on stdout (host translates it to `tud:data-synced`). */
function notifySynced(): void {
  process.stdout.write('SYNCED\n');
}

/**
 * Emit a runtime-notice marker on stdout (host translates it to `app:runtime-notice`).
 * Mirrors Electron's `broadcastConfigResetNotice`: fired once when `loadConfig`
 * recovered from a corrupt config, carrying whether the identity was salvaged.
 */
function notifyConfigReset(tokenSalvaged: boolean): void {
  process.stdout.write(`RUNTIME_NOTICE=CONFIG_RESET:${tokenSalvaged ? 'true' : 'false'}\n`);
}

function resetPollBackoffToFast(): void {
  const wasSlow = pollBackoff.currentDelayMs() > POLL_INTERVAL_MS;
  pollBackoff.reset();
  if (wasSlow) reArmPoll?.();
}

function startPricingOverlayRefresh(dir: string, config: TudConfig): Promise<void> {
  pricingRefreshStop?.();
  pricingRefreshStop = null;
  const { url } = resolvePricingRefreshConfig({
    url: config.pricing?.url,
    ttlMs: config.pricing?.ttlMs,
  });
  if (!url) return Promise.resolve();
  const handle = startPricingRefresh({
    url,
    dataDir: dir,
    firstFetchTimeoutMs: DEFAULT_PRICING_FIRST_FETCH_TIMEOUT_MS,
    onUpdate: () => {
      const current = runtime;
      if (!current) return;
      void current.aggregateCache
        .rebuildFromRows(current.bucketStore.getRows())
        .catch((err) => {
          console.warn('定价覆盖层刷新后重建缓存失败:', err instanceof Error ? err.message : err);
        });
    },
    onError: (err) => {
      console.warn('定价表远程刷新失败（继续用内置/上次覆盖）:', err instanceof Error ? err.message : err);
    },
  });
  pricingRefreshStop = handle;
  return handle.ready
    .then(() => {
      /* non-fatal */
    })
    .catch(() => {
      /* non-fatal */
    });
}

function resolvePort(): number {
  // An explicit env override wins; otherwise the desktop default (not the CLI
  // port). The bound port is always reported via PORT=, so a conflict on the
  // default falls back to an OS-assigned port below.
  const envPort = Number(process.env.TUD_SIDECAR_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return DEFAULT_DESKTOP_PORT;
}

async function boot(): Promise<void> {
  // Same takeover as the Electron cold start: evict CLI autostart so its
  // KeepAlive cannot revive the CLI, stop the CLI runtime kind, then claim the
  // runtime as the desktop owner (force).
  await evictCliAutostart();
  await evictRuntimeKind('cli', { exceptPid: process.pid });

  const { dir, config, recoveredFromCorrupt } = await loadConfig();
  ownedDir = dir;
  await touchStatsSince(dir, config);

  // A corrupt-config recovery (identity re-derived / token salvaged) is the
  // one case the Electron main surfaced to the UI as a `config-reset` notice.
  // Emit it BEFORE the port so the host can show it once the renderer is up.
  if (recoveredFromCorrupt) {
    notifyConfigReset(recoveredFromCorrupt.tokenSalvaged);
  }

  const claim = await claimRuntimeOwner(dir, { kind: 'desktop', force: true });
  if (claim.role !== 'owner') {
    throw new Error('无法抢占本地 runtime（desktop owner）');
  }
  await touchRuntimeHeartbeat({ kind: 'desktop', pid: process.pid }, dir);

  const { hookOk: claudeHookOk } = await setupClaudeHook(dir);
  const { hookOk: codexHookOk } = await setupCodexHook(dir);
  if (!claudeHookOk) {
    console.warn('[tud-sidecar] Claude Hook 未注册成功，将依赖轮询同步');
  }
  if (!codexHookOk) {
    console.warn('[tud-sidecar] Codex Hook 未注册成功，将依赖轮询同步');
  }

  const { config: refreshed } = await loadConfig(dir);
  await startPricingOverlayRefresh(dir, refreshed);

  const bucketStore = new BucketStore();
  await bucketStore.reload(dir, resolveLocalCollectSince(refreshed));
  const aggregateCache = await createAggregateCache(dir, bucketStore.getRows());

  runtime = { dir, config: refreshed, bucketStore, aggregateCache };

  const applyAfterSync = createApplyAfterSync({
    getBucketStore: () => runtime!.bucketStore,
    getAggregateCache: () => runtime?.aggregateCache,
    onApplied: notifySynced,
  });

  const { stop, runSync } = watchRuntimeSignals({
    dataDir: dir,
    getConfig: () => runtime!.config,
    setConfig: (next: TudConfig) => {
      if (runtime) runtime.config = next;
    },
    refreshFromDisk: async (results, opts) => {
      if (!runtime) return;
      // Non-quiet result delivery means a hook/manual/foreground sync ran:
      // the user is active, so snap the idle backoff back to the fast round.
      if (results && results.length > 0 && !opts?.quiet) {
        resetPollBackoffToFast();
      }
      if (!results) {
        await refreshFromDisk();
        return;
      }
      await applyAfterSync(results, opts);
    },
    isOwner: () => true,
    loadConfig,
  });
  syncWatcherStop = stop;
  runSyncFn = runSync;

  const app = createLocalApiApp({
    dataDir: dir,
    getConfig: () => runtime!.config,
    bucketStore,
    aggregateCache,
    runSyncViaRunner: (reason, source) => runSyncFn!(reason, source),
    getHookStatus: () => getHookStatus(dir),
    onConfigChange: (next) => {
      if (runtime) runtime.config = next;
    },
  });

  const host = '127.0.0.1';
  const port = resolvePort();
  const httpServer = createHttpServer({ honoApp: app, staticDir: '', host, port });

  // Bind; if the default port is taken, ask the OS for one.
  let actualPort: number;
  try {
    ({ port: actualPort } = await listenServer(httpServer, host, port));
  } catch {
    try {
      ({ port: actualPort } = await listenServer(httpServer, host, 0));
    } catch (err) {
      await releaseRuntimeOwner(dir);
      ownedDir = null;
      throw err;
    }
  }
  server = httpServer;

  // Report the bound port FIRST so the host can start health-polling / wiring.
  announcePort(actualPort);

  // Idle rounds back off 1min → 2min → 5min; any activity re-arms at 1min.
  const scheduleNextPoll = (delayMs = pollBackoff.currentDelayMs()) => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!runtime || !runSyncFn) return;
    pollTimer = setTimeout(() => {
      void runScheduledPoll();
    }, delayMs);
  };
  reArmPoll = scheduleNextPoll;

  const runScheduledPoll = async () => {
    let nextDelayMs = pollBackoff.currentDelayMs();
    try {
      if (!runtime || !runSyncFn) return;
      const results = await runSyncFn('poll');
      const wroteAny = results.some((r) => r.writtenBuckets.length > 0);
      nextDelayMs = pollBackoff.noteRound(wroteAny);
    } catch (err) {
      console.error('[tud-sidecar] poll sync failed:', err instanceof Error ? err.message : err);
    } finally {
      scheduleNextPoll(nextDelayMs);
    }
  };

  kickBackfillDrain(dir, () => runtime!.config);
  void runSync('startup')
    .catch((err) => {
      console.error('[tud-sidecar] startup sync failed:', err instanceof Error ? err.message : err);
    })
    .finally(scheduleNextPoll);
}

/** Reload buckets + cache from disk after a hook/manual signal produced no rows. */
async function refreshFromDisk(): Promise<void> {
  if (!runtime) return;
  const { config } = await loadConfig(runtime.dir);
  runtime.config = config;
  await runtime.bucketStore.refresh(
    runtime.dir,
    resolveLocalCollectSince(config),
  );
  await runtime.aggregateCache.rebuildFromRows(runtime.bucketStore.getRows());
  void writeSyncDone(runtime.dir).catch(() => {
    /* best-effort */
  });
}

async function shutdown(): Promise<void> {
  if (pricingRefreshStop) {
    pricingRefreshStop();
    pricingRefreshStop = null;
  }
  if (syncWatcherStop) {
    syncWatcherStop();
    syncWatcherStop = null;
  }
  runSyncFn = null;
  stopBackfillDrain();
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (ownedDir) {
    await releaseRuntimeOwner(ownedDir);
    ownedDir = null;
  }
}

function onSignal(): void {
  void shutdown()
    .catch((err) => {
      console.error('[tud-sidecar] shutdown error:', err instanceof Error ? err.message : err);
    })
    .finally(() => process.exit(0));
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

boot().catch((err) => {
  console.error('[tud-sidecar] boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

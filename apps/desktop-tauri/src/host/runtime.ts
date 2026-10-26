// Adapted from you-want/juejin-usage-tauri (MIT), commit 303aaf2127bc.
import {
  claimRuntimeOwner,
  createAggregateCache,
  createApplyAfterSync,
  createHttpServer,
  createLocalApiApp,
  createPollBackoff,
  DEFAULT_PRICING_FIRST_FETCH_TIMEOUT_MS,
  getHookStatus,
  kickBackfillDrain,
  listenServer,
  loadConfig,
  POLL_INTERVAL_MS,
  releaseRuntimeOwner,
  resolveLocalCollectSince,
  resolvePricingRefreshConfig,
  setupClaudeHook,
  setupCodexHook,
  startPricingRefresh,
  stopBackfillDrain,
  touchRuntimeHeartbeat,
  touchStatsSince,
  watchRuntimeSignals,
  writeSyncDone,
  BucketStore,
  HEARTBEAT_INTERVAL_MS,
  getRunningOwner,
  isRuntimeOwner,
  type AggregateCache,
  type SyncResult,
  type TudConfig,
} from '@juejin-opensource/jusage-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopLoginHandler } from './login.js';
import type { RequestListener } from 'node:http';
import { evictCliAutostart } from './evict-cli-autostart.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Let the OS assign a loopback port; never bind the CLI panel port 8452. */
const DEFAULT_DESKTOP_PORT = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let closing = false;

let server: ReturnType<typeof createHttpServer> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pricingRefreshStop: (() => void) | null = null;
let syncWatcherStop: (() => void) | null = null;
let runSyncFn: ((reason: string, source?: string) => Promise<SyncResult[]>) | null = null;
const pollBackoff = createPollBackoff();
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

function notifySynced(): void {
  process.stdout.write('SYNCED\n');
}

/**
 * Record config recovery on the host log, including identity salvage status.
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
          console.warn(
            '定价覆盖层刷新后重建缓存失败:',
            err instanceof Error ? err.message : err,
          );
        });
    },
    onError: (err) => {
      console.warn(
        '定价表远程刷新失败（继续用内置/上次覆盖）:',
        err instanceof Error ? err.message : err,
      );
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

function resolveDesktopHostPort(): number {
  const envPort = Number(process.env.TUD_SIDECAR_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return DEFAULT_DESKTOP_PORT;
}

/** Also serve the dashboard for the existing browser association callback. */
function resolveDashboardDir(): string {
  return join(__dirname, '../ui');
}

export interface BootOptions {
  dataDir?: string;
  registerHooks?: boolean;
  sync?: boolean;
  pricing?: boolean;
  evictAutostart?: boolean;
}

export async function boot(options: BootOptions = {}): Promise<void> {
  const dataDirOverride = options.dataDir ?? (process.env.TUD_DATA_DIR?.trim() || undefined);
  const { dir, config, recoveredFromCorrupt } = await loadConfig(dataDirOverride);
  // Do not kill a healthy Electron/Tauri desktop. The two clients coexist on
  // disk, but only one may own sync/upload at a time.
  const existing = await getRunningOwner(dir);
  if (existing?.kind === 'desktop' && existing.pid !== process.pid) {
    process.stdout.write('RUNTIME_BLOCKED\n');
    throw new Error('已有桌面客户端正在运行，请先退出后再启动 Tauri 客户端');
  }
  if (options.evictAutostart !== false) await evictCliAutostart();

  await touchStatsSince(dir, config);

  // A corrupt-config recovery (identity re-derived / token salvaged) is the
  // one case recorded as a config-reset notice in the host log.
  if (recoveredFromCorrupt) {
    notifyConfigReset(recoveredFromCorrupt.tokenSalvaged);
  }

  const claim = await claimRuntimeOwner(dir, { kind: 'desktop', force: true });
  if (claim.role !== 'owner') {
    throw new Error('无法抢占本地 runtime（desktop owner）');
  }
  ownedDir = dir;
  // Heartbeats are independent of sync backoff (which can reach 5 minutes).
  await touchRuntimeHeartbeat({ kind: 'desktop', pid: process.pid }, dir);

  heartbeatTimer = setInterval(() => {
    void isRuntimeOwner(dir).then(async (owner) => {
      if (!owner) { process.stdout.write('RUNTIME_BLOCKED\n'); await shutdown(); process.exit(0); }
      await touchRuntimeHeartbeat({ kind: 'desktop', pid: process.pid }, dir);
    }).catch((err) => console.error('[desktop-tauri] heartbeat:', err));
  }, HEARTBEAT_INTERVAL_MS);

  const { hookOk: claudeHookOk } = options.registerHooks === false ? { hookOk: true } : await setupClaudeHook(dir);
  const { hookOk: codexHookOk } = options.registerHooks === false ? { hookOk: true } : await setupCodexHook(dir);
  if (!claudeHookOk) {
    console.warn('[jusage desktop-host] Claude Hook 未注册成功，将依赖轮询同步');
  }
  if (!codexHookOk) {
    console.warn('[jusage desktop-host] Codex Hook 未注册成功，将依赖轮询同步');
  }

  const { config: refreshed } = await loadConfig(dir);
  if (options.pricing !== false) await startPricingOverlayRefresh(dir, refreshed);

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
    isOwner: () => !closing,
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
  const port = resolveDesktopHostPort();
  const httpServer = createHttpServer({ honoApp: app, staticDir: resolveDashboardDir(), host, port });

  const login = createDesktopLoginHandler({
    hostKey: process.env.TUD_HOST_KEY ?? '',
    apply: async (payload) => {
      const response = await app.request('/functions/tud-config', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const result = await response.json() as { success?: boolean };
      if (!response.ok || result.success !== true) throw new Error('LOGIN_WRITE_FAILED');
    },
    linked: () => { process.stdout.write('JUEJIN_LINKED\n'); },
  });
  const serve = httpServer.listeners('request')[0] as RequestListener;
  httpServer.removeListener('request', serve);
  httpServer.on('request', (req, res) => {
    void login(req, res).then(handled => { if (!handled) serve(req, res); }).catch(() => {
      res.statusCode = 500; res.end('Desktop request failed');
    });
  });

  // Bind; if the default port is taken, ask the OS for one.
  let actualPort: number;
  try {
    ({ port: actualPort } = await listenServer(httpServer, host, port));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
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
    if (closing || !runtime || !runSyncFn) return;
    pollTimer = setTimeout(() => {
      void runScheduledPoll();
    }, delayMs);
  };
  reArmPoll = scheduleNextPoll;

  const runScheduledPoll = async () => {
    let nextDelayMs = pollBackoff.currentDelayMs();
    try {
      if (closing || !runtime || !runSyncFn) return;
      const results = await runSyncFn('poll');
      const wroteAny = results.some((r) => r.writtenBuckets.length > 0);
      nextDelayMs = pollBackoff.noteRound(wroteAny);
    } catch (err) {
      console.error(
        '[jusage desktop-host] poll sync failed:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      scheduleNextPoll(nextDelayMs);
    }
  };

  if (options.sync === false) return;
  kickBackfillDrain(dir, () => runtime!.config);
  void runSync('startup')
    .catch((err) => {
      console.error(
        '[jusage desktop-host] startup sync failed:',
        err instanceof Error ? err.message : err,
      );
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

export async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
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

/**
 * Desktop runtime: BucketStore + local-api stay in the Electron main process.
 * Parsers, queue IO, and upload run in a utilityProcess so sync cannot freeze
 * the UI event loop.
 */
import {
  AggregateCache,
  BucketStore,
  POLL_INTERVAL_MS,
  appendJsonLog,
  measureCpuPhase,
  claimRuntimeOwner,
  createAggregateCache,
  createApplyAfterSync,
  createLocalApiApp,
  DEFAULT_DATA_DIR,
  evictRuntimeKind,
  getHookStatus,
  getRunningOwner,
  HEARTBEAT_INTERVAL_MS,
  loadConfig,
  releaseRuntimeOwner,
  resolveLocalCollectSince,
  resolvePricingRefreshConfig,
  DEFAULT_PRICING_FIRST_FETCH_TIMEOUT_MS,
  setupClaudeHook,
  setupCodexHook,
  startPricingRefresh,
  syncJuejinProfile,
  syncLogPath,
  touchRuntimeHeartbeat,
  clearRuntimeHeartbeat,
  touchStatsSince,
  kickBackfillDrain,
  stopBackfillDrain,
  watchRuntimeSignals,
  createPollBackoff,
  type CorruptConfigRecovery,
  type SyncResult,
  type TudConfig,
} from '@juejin-opensource/jusage-core';
import { evictCliAutostart } from './evict-cli-autostart';
import {
  isSyncWorkerRunning,
  runSyncViaWorker,
  startSyncWorker,
  stopSyncWorker,
} from './sync-worker-host';

export type LocalRuntimeSyncListener = () => void;

type LocalApiApp = ReturnType<typeof createLocalApiApp>;

interface RuntimeState {
  dir: string;
  config: TudConfig;
  bucketStore: BucketStore;
  aggregateCache: AggregateCache;
  app: LocalApiApp;
  role: 'owner';
}

/** Foreground pokes trigger at most one sync per this window. */
const FOREGROUND_POKE_DEBOUNCE_MS = 30_000;
/** How long IPC waits for recover before returning internal 503. */
const LOCAL_API_READY_WAIT_MS = 20_000;

let runtime: RuntimeState | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let syncWatcherStop: (() => void) | null = null;
let pricingRefreshStop: (() => void) | null = null;
let ownedPid = false;
let runSyncFn: ((reason: string, source?: string) => Promise<SyncResult[]>) | null =
  null;
const pollBackoff = createPollBackoff();
/** Re-arm the poll timer at the backoff's current delay (owner only). */
let reArmPoll: ((delayMs?: number) => void) | null = null;
let lastSyncDoneAt = 0;
let lastForegroundPokeAt = 0;
const syncListeners = new Set<LocalRuntimeSyncListener>();
let lastCorruptRecovery: CorruptConfigRecovery | undefined;
let quitting = false;
let ensureInFlight: Promise<{
  dataDir: string;
  role: 'owner';
  recoveredFromCorrupt?: CorruptConfigRecovery;
}> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogFailures = 0;
let watchdogTickInFlight = false;

async function startPricingOverlayRefresh(
  dir: string,
  config: TudConfig,
): Promise<void> {
  pricingRefreshStop?.();
  pricingRefreshStop = null;
  const { url } = resolvePricingRefreshConfig({
    url: config.pricing?.url,
    ttlMs: config.pricing?.ttlMs,
  });
  if (!url) return;
  const handle = startPricingRefresh({
    url,
    dataDir: dir,
    firstFetchTimeoutMs: DEFAULT_PRICING_FIRST_FETCH_TIMEOUT_MS,
    onUpdate: () => {
      const current = runtime;
      if (!current) return;
      void measureCpuPhase(
        syncLogPath(dir),
        'pricing_rebuild',
        { role: 'main' },
        () => current.aggregateCache.rebuildFromRows(current.bucketStore.getRows()),
      )
        .then(() => {
          notifySynced();
        })
        .catch((err) => {
          console.warn(
            '[tud-desktop] pricing overlay cache rebuild failed:',
            err instanceof Error ? err.message : err,
          );
        });
    },
    onError: (err) => {
      console.warn(
        '[tud-desktop] pricing overlay refresh failed:',
        err instanceof Error ? err.message : err,
      );
    },
  });
  pricingRefreshStop = handle;
  console.log(`[tud-desktop] pricing overlay: ${url} (startup fetch)`);
  await handle.ready;
}

async function refreshRuntimeFromDisk(): Promise<void> {
  if (!runtime) return;
  try {
    const { config } = await loadConfig(runtime.dir);
    runtime.config = config;
    await runtime.bucketStore.refresh(
      runtime.dir,
      resolveLocalCollectSince(config),
    );
    await runtime.aggregateCache.rebuildFromRows(runtime.bucketStore.getRows());
    await appendJsonLog(syncLogPath(runtime.dir), {
      event: 'bucket_refresh',
      statsSince: config.statsSince,
      localCollectSince: resolveLocalCollectSince(config),
      lastSyncAt: config.lastSyncAt,
    });
    notifySynced();
  } catch (err) {
    await appendJsonLog(syncLogPath(runtime.dir), {
      event: 'bucket_refresh_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Snap idle backoff to the fastest interval and re-arm the poll timer if it was slowed down. */
function resetPollBackoffToFast(): void {
  const wasSlow = pollBackoff.currentDelayMs() > POLL_INTERVAL_MS;
  pollBackoff.reset();
  if (wasSlow) reArmPoll?.();
}

/**
 * App came to the foreground (window shown/focused, tray popover opened).
 * Restores the 1-minute poll cadence and, when data is stale (no sync within
 * the last poll interval), triggers an immediate sync. Debounced so rapid
 * focus changes cannot spam syncs.
 */
export function pokeSyncOnForeground(): void {
  if (!runtime || runtime.role !== 'owner' || !runSyncFn) return;
  resetPollBackoffToFast();

  const now = Date.now();
  if (now - lastForegroundPokeAt < FOREGROUND_POKE_DEBOUNCE_MS) return;
  if (now - lastSyncDoneAt < POLL_INTERVAL_MS) return;
  lastForegroundPokeAt = now;
  void runSyncFn('foreground').catch((err) => {
    console.error(
      '[tud-desktop] foreground sync failed:',
      err instanceof Error ? err.message : err,
    );
  });
}

function notifySynced(): void {
  for (const listener of syncListeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors so one bad subscriber cannot break sync.
    }
  }
}

function buildApp(state: {
  dir: string;
  getConfig: () => TudConfig;
  bucketStore: BucketStore;
  aggregateCache: AggregateCache;
  runSyncViaRunner?: (
    reason: string,
    source?: string,
  ) => Promise<SyncResult[]>;
}): LocalApiApp {
  return createLocalApiApp({
    dataDir: state.dir,
    getConfig: state.getConfig,
    bucketStore: state.bucketStore,
    aggregateCache: state.aggregateCache,
    runSyncViaRunner: state.runSyncViaRunner,
    getHookStatus: () => getHookStatus(state.dir),
    onConfigChange: (next) => {
      if (runtime) runtime.config = next;
    },
    onSync: async () => {
      notifySynced();
    },
  });
}

/** Start Core runtime against the shared ~/.ai-usage data dir. */
export async function startLocalRuntime(): Promise<{
  dataDir: string;
  role: 'owner';
  recoveredFromCorrupt?: CorruptConfigRecovery;
}> {
  if (ensureInFlight) return ensureInFlight;
  if (runtime) {
    return {
      dataDir: runtime.dir,
      role: runtime.role,
      recoveredFromCorrupt: lastCorruptRecovery,
    };
  }
  ensureInFlight = startLocalRuntimeUnlocked().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

async function startLocalRuntimeUnlocked(): Promise<{
  dataDir: string;
  role: 'owner';
  recoveredFromCorrupt?: CorruptConfigRecovery;
}> {
  await evictCliAutostart();
  await evictRuntimeKind('cli', {
    exceptPid: process.pid,
    dataDir: DEFAULT_DATA_DIR,
  });

  const { dir, config, recoveredFromCorrupt } = await loadConfig();
  lastCorruptRecovery = recoveredFromCorrupt;
  await touchStatsSince(dir, config);

  const claim = await claimRuntimeOwner(dir, { kind: 'desktop', force: true });
  if (claim.role !== 'owner') {
    throw new Error('无法抢占本地 runtime');
  }
  ownedPid = true;
  await touchRuntimeHeartbeat({ kind: 'desktop', pid: process.pid }, dir);

  console.log(`[tud-desktop] data dir: ${dir}`);
  console.log('[tud-desktop] runtime role: owner (kind desktop)');

  const { hookOk: claudeHookOk } = await setupClaudeHook(dir);
  const { hookOk: codexHookOk } = await setupCodexHook(dir);
  if (!claudeHookOk) {
    console.warn('[tud-desktop] Claude Hook 未注册成功，将依赖轮询同步');
  }
  if (!codexHookOk) {
    console.warn('[tud-desktop] Codex Hook 未注册成功，将依赖轮询同步');
  }

  const { config: refreshed } = await loadConfig(dir);
  await startPricingOverlayRefresh(dir, refreshed);

  const bucketStore = new BucketStore();
  await bucketStore.reload(dir, resolveLocalCollectSince(refreshed));
  const aggregateCache = await createAggregateCache(dir, bucketStore.getRows());

  const state = {
    dir,
    config: refreshed,
    bucketStore,
    aggregateCache,
    role: 'owner' as const,
  };

  // Placeholder app; rebuilt after owner runner is wired so manual sync shares it.
  runtime = {
    ...state,
    app: buildApp({
      dir: state.dir,
      getConfig: () => runtime!.config,
      bucketStore: state.bucketStore,
      aggregateCache: state.aggregateCache,
    }),
  };

  const applyAfterSync = createApplyAfterSync({
    getBucketStore: () => runtime!.bucketStore,
    getAggregateCache: () => runtime?.aggregateCache,
    onApplied: notifySynced,
  });
  const timedApplyAfterSync = async (
    results: SyncResult[],
    opts?: { quiet?: boolean; forceNotify?: boolean },
  ) => {
    await measureCpuPhase(
      syncLogPath(dir),
      'apply_after_sync',
      {
        role: 'main',
        buckets: results.reduce((n, r) => n + r.writtenBuckets.length, 0),
        quiet: Boolean(opts?.quiet),
      },
      () => applyAfterSync(results, opts),
    );
  };

  const workerOk = await startSyncWorker(dir);
  if (workerOk) {
    console.log(`[tud-desktop] sync worker ready (MAIN pid=${process.pid})`);
  } else {
    console.warn('[tud-desktop] falling back to in-process sync (MAIN event loop)');
  }
  const runSyncOverride = workerOk
    ? async (reason: string, source?: string) => {
        const results = await runSyncViaWorker(reason, source);
        const { config: nextCfg } = await loadConfig(dir);
        if (runtime) runtime.config = nextCfg;
        await timedApplyAfterSync(results);
        lastSyncDoneAt = Date.now();
        if (results.length > 0 && reason !== 'poll') {
          resetPollBackoffToFast();
        }
        return results;
      }
    : undefined;

  const { stop, runSync } = watchRuntimeSignals({
    dataDir: dir,
    getConfig: () => runtime!.config,
    setConfig: (next: TudConfig) => {
      if (runtime) runtime.config = next;
    },
    // Sync already returns the latest changed buckets. Applying that delta
    // avoids reading the 1.1 GB append-only queue after every hook signal.
    refreshFromDisk: async (results, opts) => {
      if (!runtime) return;
      lastSyncDoneAt = Date.now();
      // Non-quiet result delivery means a hook/manual/foreground sync ran:
      // the user is active, so snap the idle backoff back to 1 minute.
      if (results && results.length > 0 && !opts?.quiet) {
        resetPollBackoffToFast();
      }
      if (!results) {
        await refreshRuntimeFromDisk();
        return;
      }
      await timedApplyAfterSync(results, opts);
    },
    isOwner: () => runtime?.role === 'owner',
    loadConfig,
    runSyncOverride,
  });
  syncWatcherStop = stop;
  runSyncFn = runSync;

  runtime.app = buildApp({
    dir: state.dir,
    getConfig: () => runtime!.config,
    bucketStore: state.bucketStore,
    aggregateCache: state.aggregateCache,
    runSyncViaRunner: (reason, source) => runSync(reason, source),
  });

  // A full local scan may take longer than the nominal interval. Scheduling
  // the next poll only after this one settles leaves a real idle window
  // instead of starting a new full scan immediately after a long sync.
  // Idle rounds back off 1min → 2min → 5min; any activity re-arms at 1min.
  const scheduleNextPoll = (delayMs = pollBackoff.currentDelayMs()) => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!runtime || runtime.role !== 'owner' || !runSyncFn) return;
    pollTimer = setTimeout(() => {
      void runScheduledPoll();
    }, delayMs);
  };
  reArmPoll = scheduleNextPoll;

  const runScheduledPoll = async () => {
    let nextDelayMs = pollBackoff.currentDelayMs();
    try {
      if (!runtime || runtime.role !== 'owner' || !runSyncFn) return;
      const results = await runSyncFn('poll');
      const wroteAny = results.some((r) => r.writtenBuckets.length > 0);
      nextDelayMs = pollBackoff.noteRound(wroteAny);
    } catch (err) {
      console.error(
        '[tud-desktop] poll sync failed:',
        err instanceof Error ? err.message : err,
      );
    } finally {
      scheduleNextPoll(nextDelayMs);
    }
  };

  console.log('[tud-desktop] background syncing local usage…');
  void syncJuejinProfile(dir, runtime.config)
    .then((result) => {
      if (result.changed) {
        console.log('[tud-desktop] juejin profile synced');
      }
    })
    .catch((err) => {
      console.warn(
        '[tud-desktop] juejin profile sync failed:',
        err instanceof Error ? err.message : err,
      );
    });
  if (!isSyncWorkerRunning()) {
    kickBackfillDrain(dir, () => runtime!.config);
  }
  void runSync('startup')
    .catch((err) => {
      console.error(
        '[tud-desktop] startup sync failed:',
        err instanceof Error ? err.message : err,
      );
    })
    .finally(scheduleNextPoll);

  return { dataDir: dir, role: 'owner', recoveredFromCorrupt };
}

export function setLocalRuntimeQuitting(value: boolean): void {
  quitting = value;
  if (value) stopRuntimeWatchdog();
}

/** Resume liveness heartbeat + restart loop after a pause or failed first start. */
export function resumeLocalRuntimeWatchdog(): void {
  quitting = false;
  startRuntimeWatchdog();
}

export async function ensureLocalRuntime(): Promise<{
  dataDir: string;
  role: 'owner';
  recoveredFromCorrupt?: CorruptConfigRecovery;
}> {
  if (quitting) {
    if (runtime) {
      return { dataDir: runtime.dir, role: runtime.role };
    }
    throw new Error('local runtime paused');
  }
  return startLocalRuntime();
}

/**
 * Same takeover as a cold start: stop a half-dead runtime, evict CLI, force
 * claim tud.pid, then start. Joins an in-flight start/recover instead of stacking.
 */
export async function recoverLocalRuntime(): Promise<{
  dataDir: string;
  role: 'owner';
  recoveredFromCorrupt?: CorruptConfigRecovery;
}> {
  if (quitting) {
    if (runtime) {
      return { dataDir: runtime.dir, role: runtime.role };
    }
    throw new Error('local runtime paused');
  }
  if (ensureInFlight) return ensureInFlight;
  if (!runtime) return startLocalRuntime();
  ensureInFlight = (async () => {
    await stopLocalRuntime();
    return startLocalRuntimeUnlocked();
  })().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

function watchdogBackoffMs(): number {
  if (watchdogFailures <= 1) return 2_000;
  if (watchdogFailures === 2) return 10_000;
  return HEARTBEAT_INTERVAL_MS;
}

function stopRuntimeWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function startRuntimeWatchdog(): void {
  stopRuntimeWatchdog();
  if (quitting) return;

  const schedule = (delayMs: number) => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      void runWatchdogTick().then(() => {
        if (!quitting) {
          schedule(
            watchdogFailures === 0
              ? HEARTBEAT_INTERVAL_MS
              : watchdogBackoffMs(),
          );
        }
      });
    }, delayMs);
  };
  schedule(HEARTBEAT_INTERVAL_MS);
}

async function runWatchdogTick(): Promise<void> {
  if (quitting || watchdogTickInFlight) return;
  watchdogTickInFlight = true;
  try {
    if (!runtime) {
      await recoverLocalRuntime();
      watchdogFailures = 0;
      return;
    }
    await touchRuntimeHeartbeat(
      { kind: 'desktop', pid: process.pid },
      runtime.dir,
    );
    const owner = await getRunningOwner(runtime.dir);
    if (owner != null && owner.pid !== process.pid) {
      console.warn(
        `[tud-desktop] lost runtime ownership to pid ${owner.pid}, reclaiming`,
      );
      await recoverLocalRuntime();
    }
    watchdogFailures = 0;
  } catch (err) {
    watchdogFailures += 1;
    console.error(
      '[tud-desktop] runtime watchdog failed:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    watchdogTickInFlight = false;
  }
}

export async function stopLocalRuntime(): Promise<void> {
  if (quitting) stopRuntimeWatchdog();
  if (pricingRefreshStop) {
    pricingRefreshStop();
    pricingRefreshStop = null;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (syncWatcherStop) {
    syncWatcherStop();
    syncWatcherStop = null;
  }
  runSyncFn = null;
  reArmPoll = null;
  stopSyncWorker();
  stopBackfillDrain();
  pollBackoff.reset();
  lastSyncDoneAt = 0;
  lastForegroundPokeAt = 0;
  if (ownedPid && runtime) {
    await releaseRuntimeOwner(runtime.dir);
    ownedPid = false;
  }
  if (quitting) {
    await clearRuntimeHeartbeat(runtime?.dir ?? DEFAULT_DATA_DIR);
  }
  runtime = null;
}

export function onLocalRuntimeSynced(listener: LocalRuntimeSyncListener): () => void {
  syncListeners.add(listener);
  return () => {
    syncListeners.delete(listener);
  };
}

export function isLocalRuntimeReady(): boolean {
  return runtime != null;
}

export function getLocalRuntimeDataDir(): string | null {
  return runtime?.dir ?? null;
}

export function getLocalRuntimeRole(): 'owner' | null {
  return runtime?.role ?? null;
}

/**
 * Forward a path (+ optional method/body) to the in-memory local-api Hono app.
 * `path` should look like `/functions/tud-usage-daily?days=7`.
 */
export async function localApiRequest(
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  if (!runtime && !quitting) {
    const ready = await Promise.race([
      recoverLocalRuntime()
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), LOCAL_API_READY_WAIT_MS);
      }),
    ]);
    if (!ready || !runtime) {
      return {
        status: 503,
        body: {
          success: false,
          message: 'LOCAL_RUNTIME_NOT_READY',
          data: null,
        },
      };
    }
  }

  if (!runtime) {
    return {
      status: 503,
      body: {
        success: false,
        message: 'LOCAL_RUNTIME_NOT_READY',
        data: null,
      },
    };
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  const url = path.startsWith('http')
    ? path
    : `http://tud.local${path.startsWith('/') ? path : `/${path}`}`;

  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await runtime.app.request(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : init?.body,
  });

  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { success: false, message: text, data: null };
    }
  }

  return { status: response.status, body };
}

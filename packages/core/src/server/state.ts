import type { QueueBucket, SyncStatus, TudConfig } from '../types.js';
import { AggregateCache } from '../aggregate-cache.js';
import { aggregateUsageSummary } from '../aggregate.js';
import {
  daysAgoIso,
  isLocalRangeDays,
  resolveLocalCollectSince,
  saveConfig,
} from '../config.js';
import { isClaudeHookConfigured } from '../hooks/claude.js';
import { isCodexHookConfigured } from '../hooks/codex.js';
import { notifyScriptPath, pollIntervalLabel, pollIntervalSeconds } from '../paths.js';
import {
  clearCursors,
  loadRecentBuckets,
  loadCursors,
} from '../queue/index.js';
import { bucketKey } from '../queue/keys.js';
import {
  countClaudeRows,
  countCodexRows,
  countCursorRows,
  countQoderRows,
  countTraeRows,
  countGeminiRows,
  countOpencodeRows,
  countCopilotRows,
  countAntigravityRows,
  countOpenclawRows,
  countHermesRows,
  countZcodeRows,
  countDshRows,
  countPiRows,
  countKimiRows,
  countRoocodeRows,
  countDroidRows,
  countKiroRows,
  countClineRows,
  countAmpRows,
  countQwenRows,
  countCodebuddyRows,
  countWorkbuddyRows,
  countGrokRows,
  countMimoRows,
  countEveryCodeRows,
  countOmpRows,
  countKiloCliRows,
  countKilocodeRows,
  countGooseRows,
  countZedRows,
  countWarpRows,
  syncAll,
  collectWrittenBuckets,
  type SyncResult,
} from '../sync/index.js';
import { maybeUploadAfterSync } from '../upload/client.js';

export class BucketStore {
  /**
   * Queue files are append-only. Keep the latest row per bucket in memory so
   * hook-driven syncs can apply their small delta without rescanning history.
   */
  private rows = new Map<string, QueueBucket>();

  async reload(dataDir: string, statsSince: string): Promise<void> {
    const rows = await loadRecentBuckets(dataDir, statsSince);
    this.rows = new Map(rows.map((row) => [bucketKey(row), row]));
  }

  getRows(): QueueBucket[] {
    return Array.from(this.rows.values());
  }

  async refresh(dataDir: string, statsSince: string): Promise<void> {
    await this.reload(dataDir, statsSince);
  }

  apply(buckets: QueueBucket[]): void {
    for (const bucket of buckets) {
      this.rows.set(bucketKey(bucket), bucket);
    }
  }
}

export interface LocalApiDeps {
  dataDir: string;
  getConfig: () => TudConfig;
  bucketStore: BucketStore;
  /** Closed-day aggregate cache; when set, usage APIs avoid full-row scans. */
  aggregateCache?: AggregateCache;
  /**
   * Shared sync runner (poll + notify + manual). When set, `runSync` uses it
   * so overlapping syncs coalesce instead of double-scanning.
   */
  runSyncViaRunner?: (
    reason: string,
    source?: string,
  ) => Promise<SyncResult[]>;
  onSync?: (source?: string) => Promise<void>;
  onConfigChange?: (config: TudConfig) => void;
  getHookStatus?: () => Promise<HookStatus>;
}

export interface HookStatus {
  claude: boolean;
  codex: boolean;
}

export function buildSyncStatus(
  config: TudConfig,
  rows: QueueBucket[],
  hooks: HookStatus,
  cursorError?: string | null,
): SyncStatus {
  const poll = (_source: string, message: string, rowCount: number) => ({
    status: 'ok' as const,
    rows: rowCount,
    hook: 'unsupported' as const,
    syncMode: 'poll' as const,
    message,
  });

  return {
    lastSyncAt: config.lastSyncAt ?? null,
    lastUploadAt: config.lastUploadAt ?? null,
    statsSince: config.statsSince,
    pollIntervalSeconds: pollIntervalSeconds(),
    sources: {
      claude: {
        status: 'ok',
        rows: countClaudeRows(rows),
        hook: hooks.claude ? 'active' : 'failed',
        syncMode: hooks.claude ? 'hook' : 'poll',
        ...(!hooks.claude
          ? { message: `Hook 未注册成功，将使用定时轮询（${pollIntervalLabel()}）同步` }
          : {}),
      },
      codex: {
        status: 'ok',
        rows: countCodexRows(rows),
        hook: hooks.codex ? 'active' : 'failed',
        syncMode: hooks.codex ? 'hook' : 'poll',
        ...(!hooks.codex
          ? { message: `Hook 未注册成功，将使用定时轮询（${pollIntervalLabel()}）同步` }
          : {}),
      },
      cursor: {
        status: cursorError ? 'skipped' : 'ok',
        rows: countCursorRows(rows),
        hook: 'unsupported',
        syncMode: 'poll',
        message: `Cursor 无本地 Hook，将使用定时轮询（${pollIntervalLabel()}）同步`,
        ...(cursorError ? { error: cursorError } : {}),
      },
      qoder: poll('qoder', 'Qoder / Qoder CN 使用本地 SQLite / transcript，定时轮询同步', countQoderRows(rows)),
      trae: poll(
        'trae',
        'Trae / Trae CN 需 SQLCipher 密钥（~/.ai-usage/trae-keys/）；无密钥时 sync 会 skipped',
        countTraeRows(rows),
      ),
      gemini: poll('gemini', 'Gemini CLI 读取 ~/.gemini/tmp 会话，定时轮询同步', countGeminiRows(rows)),
      opencode: poll(
        'opencode',
        'OpenCode 读取 opencode.db / storage/message，定时轮询同步',
        countOpencodeRows(rows),
      ),
      copilot: poll(
        'copilot',
        'GitHub Copilot CLI 读取 ~/.copilot/session-state，定时轮询同步',
        countCopilotRows(rows),
      ),
      antigravity: poll(
        'antigravity',
        'Antigravity 读取 ~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/brain transcript（估算 token），定时轮询同步',
        countAntigravityRows(rows),
      ),
      openclaw: poll(
        'openclaw',
        'OpenClaw 读取 ~/.openclaw*/agents/*/sessions，定时轮询同步',
        countOpenclawRows(rows),
      ),
      hermes: poll('hermes', 'Hermes 读取 ~/.hermes/**/state.db，定时轮询同步', countHermesRows(rows)),
      zcode: poll('zcode', 'ZCode 读取 ~/.zcode/cli/db/db.sqlite，定时轮询同步', countZcodeRows(rows)),
      dsh: poll('dsh', 'DeepSeek Harness 读取 ~/.dsh/sessions/**/session.jsonl.zstd，定时轮询同步', countDshRows(rows)),
      pi: poll('pi', 'pi 读取 ~/.pi/agent/sessions，定时轮询同步', countPiRows(rows)),
      kimi: poll('kimi', 'Kimi / Kimi Code 读取 wire.jsonl，定时轮询同步', countKimiRows(rows)),
      roocode: poll(
        'roocode',
        'Roo Code 读取 VS Code globalStorage tasks/ui_messages.json，定时轮询同步',
        countRoocodeRows(rows),
      ),
      droid: poll('droid', 'Droid 读取 ~/.factory/sessions/*.settings.json，定时轮询同步', countDroidRows(rows)),
      kiro: poll('kiro', 'Kiro CLI 读取 sessions/cli 与 kiro-cli SQLite，定时轮询同步', countKiroRows(rows)),
      cline: poll(
        'cline',
        'Cline 读取 VS Code globalStorage tasks/ui_messages.json，定时轮询同步',
        countClineRows(rows),
      ),
      amp: poll('amp', 'Amp 读取 ~/.local/share/amp/threads T-*.json，定时轮询同步', countAmpRows(rows)),
      qwen: poll(
        'qwen',
        'Qwen Code 读取 ~/.qwen/tmp 会话 JSONL，定时轮询同步',
        countQwenRows(rows),
      ),
      codebuddy: poll(
        'codebuddy',
        'CodeBuddy 读取 ~/.codebuddy/projects JSONL，定时轮询同步',
        countCodebuddyRows(rows),
      ),
      workbuddy: poll(
        'workbuddy',
        'WorkBuddy 读取 ~/.workbuddy/projects JSONL / SQLite，定时轮询同步',
        countWorkbuddyRows(rows),
      ),
      grok: poll(
        'grok',
        'Grok Build 读取 ~/.grok/sessions updates.jsonl 高水位差分，定时轮询同步',
        countGrokRows(rows),
      ),
      mimo: poll(
        'mimo',
        'Mimo 读取 mimocode.db（仅 mimo/xiaomi provider），定时轮询同步',
        countMimoRows(rows),
      ),
      'every-code': poll(
        'every-code',
        'Every Code 读取 ~/.code/sessions rollout token_count 差分，定时轮询同步',
        countEveryCodeRows(rows),
      ),
      omp: poll(
        'omp',
        'OMP 读取 ~/.omp/agent/sessions JSONL（与 pi 同目录时跳过），定时轮询同步',
        countOmpRows(rows),
      ),
      'kilo-cli': poll(
        'kilo-cli',
        'Kilo CLI 读取 kilo.db SQLite message 表，定时轮询同步',
        countKiloCliRows(rows),
      ),
      kilocode: poll(
        'kilocode',
        'Kilo Code 读取 VS Code globalStorage tasks/ui_messages.json，定时轮询同步',
        countKilocodeRows(rows),
      ),
      goose: poll(
        'goose',
        'Goose 读取 sessions.db accumulated_* 累计差分，定时轮询同步',
        countGooseRows(rows),
      ),
      zed: poll(
        'zed',
        'Zed 读取 threads.db BLOB 累计 token 差分，定时轮询同步',
        countZedRows(rows),
      ),
      warp: poll(
        'warp',
        'Warp 读取 warp.sqlite agent_conversations 累计 token 差分，定时轮询同步',
        countWarpRows(rows),
      ),
    },
    juejinEnabled: config.juejin.enabled,
  };
}

export async function getHookStatus(dataDir: string): Promise<HookStatus> {
  const notifyPath = notifyScriptPath(dataDir);
  try {
    const [claude, codex] = await Promise.all([
      isClaudeHookConfigured(notifyPath),
      isCodexHookConfigured(notifyPath),
    ]);
    return { claude, codex };
  } catch {
    return { claude: false, codex: false };
  }
}

/** @deprecated Use getHookStatus */
export async function getHookActive(dataDir: string): Promise<boolean> {
  const status = await getHookStatus(dataDir);
  return status.claude;
}

export function getUsageSummary(config: TudConfig, rows: QueueBucket[]) {
  return aggregateUsageSummary(rows, resolveLocalCollectSince(config));
}

/** Apply sync deltas into BucketStore + AggregateCache without full queue reload. */
export async function applySyncResults(
  deps: LocalApiDeps,
  results: SyncResult[],
): Promise<QueueBucket[]> {
  const written = collectWrittenBuckets(results);
  if (written.length > 0) {
    deps.bucketStore.apply(written);
  }
  if (deps.aggregateCache) {
    await deps.aggregateCache.onBucketsChanged(deps.bucketStore.getRows(), written);
  }
  return written;
}

export async function runSync(
  deps: LocalApiDeps,
  source?: string,
): Promise<{ ok: boolean; results: Awaited<ReturnType<typeof syncAll>> }> {
  // Prefer shared runner so manual sync cannot overlap poll/notify.
  if (deps.runSyncViaRunner) {
    // The runner already applies results and notifies the UI exactly once
    // when data changed (afterSync / onRoundComplete). Calling `onSync` here
    // as well would broadcast a second data-synced event per manual sync.
    const results = await deps.runSyncViaRunner('manual', source);
    return { ok: true, results };
  }

  const config = deps.getConfig();
  const results = await syncAll(deps.dataDir, config, source);
  await applySyncResults(deps, results);
  await maybeUploadAfterSync(deps.dataDir, config, collectWrittenBuckets(results));
  if (deps.onSync) await deps.onSync(source);
  return { ok: true, results };
}

/**
 * Expand local collect floor to cover `days` (今天/7D/30D/90D).
 * When expansion is needed, clears cursors only (keeps queue) and re-syncs so
 * parsers re-read Agent logs for the wider window. Also moves upload
 * `statsSince` earlier (never later) so the cloud window can catch up.
 */
export async function ensureLocalCollectRange(
  deps: LocalApiDeps,
  days: number,
): Promise<{
  expanded: boolean;
  config: TudConfig;
  sync: Awaited<ReturnType<typeof runSync>> | null;
}> {
  if (!isLocalRangeDays(days)) {
    throw new Error(`INVALID_RANGE_DAYS:${days}`);
  }

  const config = deps.getConfig();
  const neededSince = daysAgoIso(days);
  const neededMs = new Date(neededSince).getTime();
  const current = resolveLocalCollectSince(config);
  const collectCovered =
    current && new Date(current).getTime() <= neededMs;
  const statsMs = Date.parse(config.statsSince ?? '');
  const statsNeedsExpand = !Number.isFinite(statsMs) || statsMs > neededMs;

  if (collectCovered && !statsNeedsExpand) {
    return { expanded: false, config, sync: null };
  }

  if (!collectCovered) {
    config.localCollectSince = neededSince;
  }
  if (statsNeedsExpand) {
    config.statsSince = neededSince;
  }
  await saveConfig(deps.dataDir, config);
  deps.onConfigChange?.(config);

  if (collectCovered) {
    if (statsNeedsExpand) {
      await maybeUploadAfterSync(deps.dataDir, config);
    }
    return { expanded: false, config, sync: null };
  }

  // Keep existing queue; only reset incremental cursors so parsers backfill.
  await clearCursors(deps.dataDir);
  const sync = await runSync(deps);
  return { expanded: true, config, sync };
}

export async function getSyncStatusPayload(
  dataDir: string,
  config: TudConfig,
  rows: QueueBucket[],
  hooks?: HookStatus,
): Promise<SyncStatus> {
  const hookStatus = hooks ?? (await getHookStatus(dataDir));
  const cursors = await loadCursors(dataDir);
  return buildSyncStatus(config, rows, hookStatus, cursors.cursor?.lastError ?? null);
}

/**
 * Helper for CLI/Desktop: create AggregateCache, load sealed days, rebuild if empty.
 */
export async function createAggregateCache(
  dataDir: string,
  rows: QueueBucket[],
): Promise<AggregateCache> {
  const cache = new AggregateCache(dataDir);
  await cache.ensureLoaded();
  if (cache.sealedDayCount() === 0 && rows.length > 0) {
    await cache.rebuildFromRows(rows);
  } else {
    await cache.onBucketsChanged(rows, []);
  }
  return cache;
}

/** Wire a createSyncRunner afterSync that applies deltas (no full refresh). */
export function createApplyAfterSync(deps: {
  getBucketStore: () => BucketStore;
  getAggregateCache: () => AggregateCache | undefined;
  onApplied?: () => void;
}): (
  results: SyncResult[],
  opts?: { quiet?: boolean; forceNotify?: boolean },
) => Promise<void> {
  return async (results, opts) => {
    const written = collectWrittenBuckets(results);
    if (written.length > 0) {
      const store = deps.getBucketStore();
      store.apply(written);
      const cache = deps.getAggregateCache();
      if (cache) {
        await cache.onBucketsChanged(store.getRows(), written);
      }
    }
    // Skip Renderer poke when sync wrote nothing (unless forceNotify for round end).
    if (opts?.quiet) return;
    if (written.length > 0 || opts?.forceNotify) {
      deps.onApplied?.();
    }
  };
}

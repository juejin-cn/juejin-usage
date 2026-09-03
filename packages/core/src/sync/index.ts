import { resolveLocalCollectSince, setLastSyncAt } from '../config.js';
import type { CursorsFile, QueueBucket, TudConfig } from '../types.js';
import { CURSOR_POLL_MIN_FETCH_INTERVAL_MS, SYNC_SOURCE_GAP_MS, syncLogPath } from '../paths.js';
import { measureCpuPhase } from '../debug-log.js';
import { isSyncSourcePresent } from './source-presence.js';
import { parseClaudeIncremental } from '../parsers/claude.js';
import { parseCodexIncremental } from '../parsers/codex.js';
import { parseCursorIncremental } from '../parsers/cursor.js';
import { parseQoderIncremental } from '../parsers/qoder.js';
import { parseTraeIncremental } from '../parsers/trae.js';
import { parseGeminiIncremental } from '../parsers/gemini.js';
import { parseOpencodeIncremental } from '../parsers/opencode.js';
import { parseCopilotIncremental } from '../parsers/copilot.js';
import { parseAntigravityIncremental } from '../parsers/antigravity.js';
import { parseOpenclawIncremental } from '../parsers/openclaw.js';
import { parseHermesIncremental } from '../parsers/hermes.js';
import { parseZcodeIncremental } from '../parsers/zcode.js';
import { parseDshIncremental } from '../parsers/dsh.js';
import { parsePiIncremental } from '../parsers/pi.js';
import { parseKimiIncremental } from '../parsers/kimi.js';
import { parseRoocodeIncremental } from '../parsers/roocode.js';
import { parseDroidIncremental } from '../parsers/droid.js';
import { parseKiroIncremental } from '../parsers/kiro.js';
import { parseClineIncremental } from '../parsers/cline.js';
import { parseAmpIncremental } from '../parsers/amp.js';
import { parseQwenIncremental } from '../parsers/qwen.js';
import { parseCodebuddyIncremental } from '../parsers/codebuddy.js';
import { parseWorkbuddyIncremental } from '../parsers/workbuddy.js';
import { parseGrokBuildIncremental } from '../parsers/grok.js';
import { parseMimoIncremental } from '../parsers/mimo.js';
import { parseEveryCodeIncremental } from '../parsers/every-code.js';
import { parseOmpIncremental, ompAgentDirCollidesWithPi } from '../parsers/omp.js';
import { parseKiloCliIncremental } from '../parsers/kilo-cli.js';
import { parseKilocodeIncremental } from '../parsers/kilocode.js';
import { parseGooseIncremental } from '../parsers/goose.js';
import { parseZedIncremental } from '../parsers/zed.js';
import { parseWarpIncremental } from '../parsers/warp.js';
import {
  appendBuckets,
  loadBucketsForRange,
  loadCursors,
  saveCursors,
  syncMutatedCursors,
} from '../queue/index.js';
import { bucketKey, monthFromHourStart } from '../queue/keys.js';
import {
  alignUnknownIntoDominant,
  UNKNOWN_MODEL,
  unknownAlignGroupKey,
} from '../queue/align-unknown.js';

export interface SyncResult {
  source: string;
  eventsParsed: number;
  filesProcessed: number;
  bucketsWritten: number;
  /** Buckets appended to queue this sync (latest row per key). */
  writtenBuckets: QueueBucket[];
  skipped?: boolean;
  error?: string;
}

export interface SyncSourceOptions {
  /**
   * Cursors shared across a full sync round so cursors.json is loaded once
   * instead of per channel. The round owner is responsible for the final
   * save; sources that appended buckets still persist immediately to keep
   * the dedup-state crash window as narrow as before.
   */
  sharedCursors?: CursorsFile;
  /** Passed to the cursor channel: minimum interval between remote fetches. */
  cursorMinFetchIntervalMs?: number;
}

function mergeBuckets(a: QueueBucket, b: QueueBucket): QueueBucket {
  return {
    hour_start: a.hour_start,
    source: a.source,
    model: a.model,
    project: a.project,
    ...(a.collector || b.collector
      ? { collector: a.collector || b.collector }
      : {}),
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    conversation_count: a.conversation_count + b.conversation_count,
    ...(a.reported_cost_usd != null || b.reported_cost_usd != null
      ? {
          reported_cost_usd:
            (a.reported_cost_usd ?? 0) + (b.reported_cost_usd ?? 0),
        }
      : {}),
  };
}

function bucketChanged(a: QueueBucket, b: QueueBucket): boolean {
  return (
    a.total_tokens !== b.total_tokens ||
    a.conversation_count !== b.conversation_count
  );
}

async function syncSourceBuckets(
  dataDir: string,
  config: TudConfig,
  source: string,
  parseFn: (
    cursors: Awaited<ReturnType<typeof loadCursors>>,
    statsSince: string,
  ) => Promise<{
    result: {
      buckets: QueueBucket[];
      eventsParsed: number;
      filesProcessed: number;
      skipped?: boolean;
      error?: string;
    };
    cursors: Awaited<ReturnType<typeof loadCursors>>;
  }>,
  options?: { replace?: boolean; sharedCursors?: CursorsFile },
): Promise<SyncResult> {
  const collectSince = resolveLocalCollectSince(config);
  const shared = options?.sharedCursors;
  let cursors = shared ?? (await loadCursors(dataDir));
  const { result, cursors: nextCursors } = await parseFn(cursors, collectSince);
  cursors = nextCursors;

  if (result.skipped) {
    if (!shared) await saveCursors(dataDir, cursors);
    return {
      source,
      eventsParsed: result.eventsParsed,
      filesProcessed: result.filesProcessed,
      bucketsWritten: 0,
      writtenBuckets: [],
      skipped: true,
      error: result.error,
    };
  }

  // No new buckets → skip queue merge/IO entirely (source fingerprint unchanged).
  if (result.buckets.length === 0) {
    if (!shared) await saveCursors(dataDir, cursors);
    await setLastSyncAt(dataDir, config);
    return {
      source,
      eventsParsed: result.eventsParsed,
      filesProcessed: result.filesProcessed,
      bucketsWritten: 0,
      writtenBuckets: [],
    };
  }

  // Only buckets in months touched by this incremental parser can be merged.
  // Scanning every historical queue file here turns one Codex hook event into
  // a multi-gigabyte read as the append-only queue grows.
  const touchedMonths = Array.from(
    new Set(result.buckets.map((bucket) => monthFromHourStart(bucket.hour_start))),
  );
  const existing = await loadBucketsForRange(
    dataDir,
    collectSince,
    touchedMonths,
  );
  const existingMap = new Map(existing.map((r) => [bucketKey(r), r]));

  const toAppend: QueueBucket[] = [];
  const working = new Map(existingMap);
  for (const delta of result.buckets) {
    const key = bucketKey(delta);
    const prev = working.get(key);
    working.set(key, options?.replace ? delta : prev ? mergeBuckets(prev, delta) : delta);
  }
  const touched = new Set(result.buckets.map((bucket) => unknownAlignGroupKey(bucket)));
  const everyCodeUnknownGroups = new Set<string>();
  if (source === 'codex') {
    for (const row of working.values()) {
      if (
        row.source === 'every-code' &&
        row.model === UNKNOWN_MODEL &&
        (row.total_tokens > 0 || row.conversation_count > 0)
      ) {
        everyCodeUnknownGroups.add(unknownAlignGroupKey(row));
      }
    }
  }
  const candidates = Array.from(working.values()).filter((row) => {
    if (row.source === source && touched.has(unknownAlignGroupKey(row))) return true;
    return source === 'codex' && everyCodeUnknownGroups.has(unknownAlignGroupKey(row));
  });
  const aligned = alignUnknownIntoDominant(candidates, {
    retractUnknown: true,
    contextBuckets: Array.from(working.values()),
  });
  for (const bucket of aligned) {
    const key = bucketKey(bucket);
    const prev = existingMap.get(key);
    if (!prev || bucketChanged(prev, bucket)) {
      toAppend.push(bucket);
      existingMap.set(key, bucket);
    }
  }

  if (toAppend.length > 0) {
    await appendBuckets(dataDir, toAppend);
    // Buckets are on disk now; persist dedup/offset state immediately even in
    // shared-cursors mode so a crash cannot double-count the appended rows.
    await saveCursors(dataDir, cursors);
  } else if (!shared) {
    await saveCursors(dataDir, cursors);
  }
  await setLastSyncAt(dataDir, config);

  return {
    source,
    eventsParsed: result.eventsParsed,
    filesProcessed: result.filesProcessed,
    bucketsWritten: toAppend.length,
    writtenBuckets: toAppend,
  };
}

export async function syncClaude(
  dataDir: string,
  config: TudConfig,
  opts?: SyncSourceOptions,
): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'claude', parseClaudeIncremental, {
    sharedCursors: opts?.sharedCursors,
  });
}

export async function syncCodex(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'codex', parseCodexIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncQoder(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'qoder', parseQoderIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncTrae(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(
    dataDir,
    config,
    'trae',
    (cursors, statsSince) => parseTraeIncremental(cursors, statsSince, { dataDir }),
    { sharedCursors: opts?.sharedCursors },
  );
}

export async function syncGemini(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'gemini', parseGeminiIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncOpencode(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'opencode', parseOpencodeIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncCopilot(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'copilot', parseCopilotIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncAntigravity(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'antigravity', parseAntigravityIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncOpenclaw(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'openclaw', parseOpenclawIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncHermes(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'hermes', parseHermesIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncZcode(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'zcode', parseZcodeIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncDsh(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'dsh', parseDshIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncPi(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'pi', parsePiIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncKimi(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'kimi', parseKimiIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncRoocode(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'roocode', parseRoocodeIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncDroid(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'droid', parseDroidIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncKiro(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'kiro', parseKiroIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncCline(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'cline', parseClineIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncAmp(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'amp', parseAmpIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncQwen(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'qwen', parseQwenIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncCodebuddy(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'codebuddy', parseCodebuddyIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncWorkbuddy(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'workbuddy', parseWorkbuddyIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncGrok(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'grok', parseGrokBuildIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncMimo(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'mimo', parseMimoIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncEveryCode(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'every-code', parseEveryCodeIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncOmp(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'omp', parseOmpIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncKiloCli(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'kilo-cli', parseKiloCliIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncKilocode(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'kilocode', parseKilocodeIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncGoose(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'goose', parseGooseIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncZed(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'zed', parseZedIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncWarp(dataDir: string, config: TudConfig, opts?: SyncSourceOptions): Promise<SyncResult> {
  return syncSourceBuckets(dataDir, config, 'warp', parseWarpIncremental, { sharedCursors: opts?.sharedCursors });
}

export async function syncCursor(
  dataDir: string,
  config: TudConfig,
  opts?: SyncSourceOptions,
): Promise<SyncResult> {
  const collectSince = resolveLocalCollectSince(config);
  const shared = opts?.sharedCursors;
  let cursors = shared ?? (await loadCursors(dataDir));
  const { result, cursors: nextCursors } = await parseCursorIncremental(cursors, collectSince, {
    minFetchIntervalMs: opts?.cursorMinFetchIntervalMs,
  });
  cursors = nextCursors;

  if (result.skipped) {
    if (!shared) await saveCursors(dataDir, cursors);
    return {
      source: 'cursor',
      eventsParsed: result.eventsParsed,
      filesProcessed: result.filesProcessed,
      bucketsWritten: 0,
      writtenBuckets: [],
      skipped: true,
      error: result.error,
    };
  }

  if (result.buckets.length === 0) {
    if (!shared) await saveCursors(dataDir, cursors);
    await setLastSyncAt(dataDir, config);
    return {
      source: 'cursor',
      eventsParsed: result.eventsParsed,
      filesProcessed: result.filesProcessed,
      bucketsWritten: 0,
      writtenBuckets: [],
    };
  }

  const touchedMonths = Array.from(
    new Set(result.buckets.map((bucket) => monthFromHourStart(bucket.hour_start))),
  );
  const existing = await loadBucketsForRange(dataDir, collectSince, touchedMonths);
  const existingMap = new Map(existing.map((r) => [bucketKey(r), r]));
  const newKeys = new Set(result.buckets.map((b) => bucketKey(b)));

  let earliestBucket: string | null = null;
  for (const bucket of result.buckets) {
    if (!earliestBucket || bucket.hour_start < earliestBucket) earliestBucket = bucket.hour_start;
  }

  const toAppend: QueueBucket[] = [];
  for (const bucket of result.buckets) {
    const key = bucketKey(bucket);
    const prev = existingMap.get(key);
    if (!prev || bucketChanged(prev, bucket)) {
      toAppend.push(bucket);
      existingMap.set(key, bucket);
    }
  }

  if (earliestBucket) {
    for (const row of existing) {
      if (row.source !== 'cursor') continue;
      if (row.hour_start < earliestBucket) continue;
      const key = bucketKey(row);
      if (newKeys.has(key)) continue;
      const zeroed: QueueBucket = {
        ...row,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        conversation_count: 0,
      };
      const prev = existingMap.get(key);
      if (!prev || bucketChanged(prev, zeroed)) {
        toAppend.push(zeroed);
        existingMap.set(key, zeroed);
      }
    }
  }

  if (toAppend.length > 0) {
    await appendBuckets(dataDir, toAppend);
    await saveCursors(dataDir, cursors);
  } else if (!shared) {
    await saveCursors(dataDir, cursors);
  }
  await setLastSyncAt(dataDir, config);

  return {
    source: 'cursor',
    eventsParsed: result.eventsParsed,
    filesProcessed: result.filesProcessed,
    bucketsWritten: toAppend.length,
    writtenBuckets: toAppend,
  };
}

/** Merge buckets written across sources in one sync pass (last wins per queue key). */
export function collectWrittenBuckets(results: SyncResult[]): QueueBucket[] {
  const map = new Map<string, QueueBucket>();
  for (const r of results) {
    for (const bucket of r.writtenBuckets) {
      map.set(bucketKey(bucket), bucket);
    }
  }
  return Array.from(map.values());
}

/** Canonical channel order for full / staggered sync rounds. */
export const SYNC_SOURCE_IDS = [
  'claude',
  'codex',
  'cursor',
  'qoder',
  'trae',
  'gemini',
  'opencode',
  'copilot',
  'antigravity',
  'openclaw',
  'hermes',
  'zcode',
  'dsh',
  'pi',
  'kimi',
  'roocode',
  'droid',
  'kiro',
  'cline',
  'amp',
  'qwen',
  'codebuddy',
  'workbuddy',
  'grok',
  'mimo',
  'every-code',
  'omp',
  'kilo-cli',
  'kilocode',
  'goose',
  'zed',
  'warp',
] as const;

export type SyncSourceId = (typeof SYNC_SOURCE_IDS)[number];

async function syncOneSource(
  dataDir: string,
  config: TudConfig,
  source: string,
  opts?: SyncSourceOptions,
): Promise<SyncResult> {
  switch (source) {
    case 'claude':
      return syncClaude(dataDir, config, opts);
    case 'codex':
      return syncCodex(dataDir, config, opts);
    case 'cursor':
      return syncCursor(dataDir, config, opts);
    case 'qoder':
      return syncQoder(dataDir, config, opts);
    case 'trae':
      return syncTrae(dataDir, config, opts);
    case 'gemini':
      return syncGemini(dataDir, config, opts);
    case 'opencode':
      return syncOpencode(dataDir, config, opts);
    case 'copilot':
      return syncCopilot(dataDir, config, opts);
    case 'antigravity':
      return syncAntigravity(dataDir, config, opts);
    case 'openclaw':
      return syncOpenclaw(dataDir, config, opts);
    case 'hermes':
      return syncHermes(dataDir, config, opts);
    case 'zcode':
      return syncZcode(dataDir, config, opts);
    case 'dsh':
      return syncDsh(dataDir, config, opts);
    case 'pi':
      return syncPi(dataDir, config, opts);
    case 'kimi':
      return syncKimi(dataDir, config, opts);
    case 'roocode':
    case 'roo-code':
      return syncRoocode(dataDir, config, opts);
    case 'droid':
      return syncDroid(dataDir, config, opts);
    case 'kiro':
      return syncKiro(dataDir, config, opts);
    case 'cline':
      return syncCline(dataDir, config, opts);
    case 'amp':
      return syncAmp(dataDir, config, opts);
    case 'qwen':
    case 'qwen-code':
      return syncQwen(dataDir, config, opts);
    case 'codebuddy':
      return syncCodebuddy(dataDir, config, opts);
    case 'workbuddy':
      return syncWorkbuddy(dataDir, config, opts);
    case 'grok':
    case 'grok-build':
      return syncGrok(dataDir, config, opts);
    case 'mimo':
    case 'mimocode':
      return syncMimo(dataDir, config, opts);
    case 'every-code':
    case 'everycode':
      return syncEveryCode(dataDir, config, opts);
    case 'omp':
      return syncOmp(dataDir, config, opts);
    case 'kilo-cli':
    case 'kilo':
      return syncKiloCli(dataDir, config, opts);
    case 'kilocode':
    case 'kilo-code':
      return syncKilocode(dataDir, config, opts);
    case 'goose':
      return syncGoose(dataDir, config, opts);
    case 'zed':
      return syncZed(dataDir, config, opts);
    case 'warp':
      return syncWarp(dataDir, config, opts);
    default:
      return {
        source,
        eventsParsed: 0,
        filesProcessed: 0,
        bucketsWritten: 0,
        writtenBuckets: [],
        skipped: true,
        error: `unknown source: ${source}`,
      };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fast path: sync one or all sources back-to-back (manual / hook).
 */
export async function syncAll(
  dataDir: string,
  config: TudConfig,
  source?: string,
): Promise<SyncResult[]> {
  if (source) {
    if (source === 'omp' && ompAgentDirCollidesWithPi()) {
      return [];
    }
    return [await syncOneSource(dataDir, config, source)];
  }

  // One cursors.json load/save per round instead of per channel.
  const logPath = syncLogPath(dataDir);
  const sharedCursors = await measureCpuPhase(logPath, 'load_cursors', {}, () =>
    loadCursors(dataDir),
  );
  const results: SyncResult[] = [];
  try {
    for (const id of SYNC_SOURCE_IDS) {
      if (id === 'omp' && ompAgentDirCollidesWithPi()) continue;
      results.push(
        await measureCpuPhase(logPath, 'source', { source: id }, () =>
          syncOneSource(dataDir, config, id, { sharedCursors }),
        ),
      );
    }
  } finally {
    if (syncMutatedCursors(results)) {
      await measureCpuPhase(logPath, 'save_cursors', {}, () =>
        saveCursors(dataDir, sharedCursors),
      );
    }
  }
  return results;
}

export interface SyncStaggeredOptions {
  /** Delay between channels (default SYNC_SOURCE_GAP_MS). */
  gapMs?: number;
  /** Called after each channel so UI can apply deltas without waiting for the round. */
  onSourceDone?: (result: SyncResult) => void | Promise<void>;
}

/**
 * Background poll path: one channel at a time.
 * Missing installs are skipped without sleeping; pause `gapMs` only after a
 * source that actually ran. Caller schedules the next round after
 * POLL_INTERVAL_MS once this resolves.
 */
export async function syncAllStaggered(
  dataDir: string,
  config: TudConfig,
  options: SyncStaggeredOptions = {},
): Promise<SyncResult[]> {
  const gapMs = options.gapMs ?? SYNC_SOURCE_GAP_MS;
  const results: SyncResult[] = [];
  const logPath = syncLogPath(dataDir);

  // One cursors.json load/save per round instead of per channel. Background
  // polls also throttle the cursor channel's remote fetch.
  const sharedCursors = await measureCpuPhase(logPath, 'load_cursors', {}, () =>
    loadCursors(dataDir),
  );
  const sourceOpts: SyncSourceOptions = {
    sharedCursors,
    cursorMinFetchIntervalMs: CURSOR_POLL_MIN_FETCH_INTERVAL_MS,
  };

  try {
    for (let i = 0; i < SYNC_SOURCE_IDS.length; i++) {
      const id = SYNC_SOURCE_IDS[i]!;
      let result: SyncResult;

      if (id === 'omp' && ompAgentDirCollidesWithPi()) {
        result = {
          source: id,
          eventsParsed: 0,
          filesProcessed: 0,
          bucketsWritten: 0,
          writtenBuckets: [],
          skipped: true,
          error: 'omp collides with pi sessions dir',
        };
      } else if (!isSyncSourcePresent(id)) {
        result = {
          source: id,
          eventsParsed: 0,
          filesProcessed: 0,
          bucketsWritten: 0,
          writtenBuckets: [],
          skipped: true,
          error: 'not installed / no local data',
        };
      } else {
        result = await measureCpuPhase(
          logPath,
          'source',
          { source: id },
          () => syncOneSource(dataDir, config, id, sourceOpts),
        );
      }

      results.push(result);
      await options.onSourceDone?.(result);

      // Missing installs are skipped in microseconds; don't burn 1s per
      // absent channel. Only pause after a source that actually ran.
      if (!result.skipped && i < SYNC_SOURCE_IDS.length - 1) {
        await sleep(gapMs);
      }
    }
  } finally {
    if (syncMutatedCursors(results)) {
      await measureCpuPhase(logPath, 'save_cursors', {}, () =>
        saveCursors(dataDir, sharedCursors),
      );
    }
  }

  return results;
}

export function countClaudeRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'claude').length;
}

export function countCodexRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'codex').length;
}

export function countCursorRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'cursor').length;
}

export function countQoderRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'qoder').length;
}

export function countTraeRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'trae').length;
}

export function countGeminiRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'gemini').length;
}

export function countOpencodeRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'opencode').length;
}

export function countCopilotRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'copilot').length;
}

export function countAntigravityRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'antigravity').length;
}

export function countOpenclawRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'openclaw').length;
}

export function countHermesRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'hermes').length;
}

export function countZcodeRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'zcode').length;
}

export function countDshRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'dsh').length;
}

export function countPiRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'pi').length;
}

export function countKimiRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'kimi').length;
}

export function countRoocodeRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'roocode').length;
}

export function countDroidRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'droid').length;
}

export function countKiroRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'kiro').length;
}

export function countClineRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'cline').length;
}

export function countAmpRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'amp').length;
}

export function countQwenRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'qwen').length;
}

export function countCodebuddyRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'codebuddy').length;
}

export function countWorkbuddyRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'workbuddy').length;
}

export function countGrokRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'grok').length;
}

export function countMimoRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'mimo').length;
}

export function countEveryCodeRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'every-code').length;
}

export function countOmpRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'omp').length;
}

export function countKiloCliRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'kilo-cli').length;
}

export function countKilocodeRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'kilocode').length;
}

export function countGooseRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'goose').length;
}

export function countZedRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'zed').length;
}

export function countWarpRows(rows: QueueBucket[]): number {
  return rows.filter((r) => r.source === 'warp').length;
}

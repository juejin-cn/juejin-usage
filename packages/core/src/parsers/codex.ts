import { localEvidence, validUsageFields } from '../local-metrics.js';
import { createReadStream, type Stats } from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import type {
  CodexFileCursor,
  CodexSessionFileMeta,
  CursorsFile,
  QueueBucket,
  TokenTotals,
} from '../types.js';
import { codexSessionsDirs } from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  modelFromRolloutEvent,
  readModel,
  recoverLastModelBeforeOffset,
} from './rollout-model.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  findJsonlFiles,
  type BucketAccumulator,
} from './shared.js';

interface SessionMeta {
  id?: string;
  forked_from_id?: string | null;
  cwd?: string;
  git?: { repository_url?: string };
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function extractProject(meta: SessionMeta): string {
  const url = meta.git?.repository_url;
  if (url) {
    const match = url.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1]!;
  }
  if (meta.cwd) {
    return resolveProjectName(meta.cwd);
  }
  return 'unknown';
}

function extractTokenCount(obj: Record<string, unknown>): { info: Record<string, unknown> | null; timestamp: string | null } | null {
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload) return null;
  if (payload.type === 'token_count') {
    const info = payload.info;
    return {
      info: info && typeof info === 'object' ? (info as Record<string, unknown>) : null,
      timestamp: (obj.timestamp as string) ?? null,
    };
  }
  const msg = payload.msg as Record<string, unknown> | undefined;
  if (msg?.type === 'token_count') {
    const info = msg.info;
    return {
      info: info && typeof info === 'object' ? (info as Record<string, unknown>) : null,
      timestamp: (obj.timestamp as string) ?? null,
    };
  }
  return null;
}

function normalizeCodexUsage(u: TokenUsage): TokenTotals | null {
  const cached = Math.max(0, u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0);
  const reasoning = Math.max(0, u.reasoning_output_tokens ?? 0);
  const input = Math.max(0, (u.input_tokens ?? 0) - cached);
  const output = Math.max(0, (u.output_tokens ?? 0) - reasoning);
  const cacheCreation = Math.max(0, u.cache_creation_input_tokens ?? 0);
  const totals = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheCreation,
    reasoning_output_tokens: reasoning,
  };
  const total = computeTotalTokens(totals);
  if (total === 0) return null;
  return { ...totals, total_tokens: total, conversation_count: 1 };
}

function pickDelta(
  lastUsage: TokenUsage | undefined,
  totalUsage: TokenUsage | undefined,
  prevTotals: TokenUsage | undefined,
): TokenUsage | null {
  if (lastUsage && Object.keys(lastUsage).length > 0) return lastUsage;
  if (totalUsage && prevTotals) {
    const delta: TokenUsage = {};
    for (const k of [
      'input_tokens',
      'cached_input_tokens',
      'cache_creation_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
      'total_tokens',
    ] as const) {
      const a = Number(totalUsage[k]);
      const b = Number(prevTotals[k]);
      if (Number.isFinite(a) && Number.isFinite(b)) delta[k] = Math.max(0, a - b);
    }
    return delta;
  }
  if (totalUsage && Object.keys(totalUsage).length > 0) return totalUsage;
  return null;
}

async function indexSessionFile(filePath: string): Promise<{
  sessionId: string | null;
  forkedFromId: string | null;
  sessionProject: string;
  tokenCountRecords: number;
}> {
  let sessionId: string | null = null;
  let forkedFromId: string | null = null;
  let sessionProject = 'unknown';
  let tokenCountRecords = 0;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === 'session_meta') {
        const meta = obj.payload as SessionMeta;
        sessionId = meta.id ?? sessionId;
        forkedFromId = meta.forked_from_id ?? null;
        sessionProject = extractProject(meta);
      } else if (extractTokenCount(obj)) {
        tokenCountRecords += 1;
      }
    } catch {
      continue;
    }
  }

  return { sessionId, forkedFromId, sessionProject, tokenCountRecords };
}

export async function listCodexRolloutFiles(): Promise<string[]> {
  const nested = await Promise.all(codexSessionsDirs().map((dir) => findJsonlFiles(dir)));
  return [...new Set(nested.flat())].sort();
}

export interface ParseCodexResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
}

export async function parseCodexIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseCodexResult; cursors: CursorsFile }> {
  const files = await listCodexRolloutFiles();
  const sinceMs = new Date(statsSince).getTime();

  if (!cursors.codex) {
    cursors.codex = { files: {}, sessionIndex: {}, seenHashes: [] };
  }
  const codexCursor = cursors.codex;
  if (!codexCursor.sessionIndex) codexCursor.sessionIndex = {};
  if (!codexCursor.files) codexCursor.files = {};
  const seenHashes = new Set(codexCursor.seenHashes ?? []);
  const bucketState: BucketAccumulator = new Map();

  const fileMeta = new Map<string, CodexSessionFileMeta>();
  const fileStats = new Map<string, Stats>();

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;
    fileStats.set(filePath, st);

    // Unchanged file (same inode, same size): reuse cached meta instead of
    // re-reading the whole session file every poll round.
    const prev = codexCursor.files[filePath];
    const cached = prev?.meta;
    const meta: CodexSessionFileMeta =
      cached && prev.inode === st.ino && cached.size === st.size
        ? cached
        : { ...(await indexSessionFile(filePath)), size: st.size };

    fileMeta.set(filePath, meta);
    if (prev && prev.inode === st.ino) prev.meta = meta;
    if (meta.sessionId) {
      codexCursor.sessionIndex[meta.sessionId] = {
        tokenCount: meta.tokenCountRecords,
        forkedFrom: meta.forkedFromId,
      };
    }
  }

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of files) {
    const st = fileStats.get(filePath);
    if (!st) continue;

    const meta = fileMeta.get(filePath);
    if (!meta) continue;

    const prev = codexCursor.files[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;
    let tokenCountSeen = sameInode && !truncated ? (prev.tokenCountSeen ?? 0) : 0;
    const prevTotalMap = new Map<string, TokenUsage>(
      sameInode && !truncated && prev?.prevTotal
        ? Object.entries(prev.prevTotal).map(([k, v]) => [k, v as TokenUsage])
        : [],
    );

    if (sameInode && !truncated && startOffset >= st.size) continue;

    const replayTokenCountToSkip = meta.forkedFromId
      ? (codexCursor.sessionIndex[meta.forkedFromId]?.tokenCount ?? 0)
      : 0;

    let lastUsageSnapshot =
      startOffset > 0 ? prev?.lastUsageSnapshot : undefined;

    let turnContextModel =
      sameInode && !truncated
        ? (readModel(prev?.lastModel) ?? 'unknown')
        : 'unknown';
    if (
      sameInode &&
      !truncated &&
      startOffset > 0 &&
      !readModel(prev?.lastModel)
    ) {
      const recovered = await recoverLastModelBeforeOffset(
        filePath,
        startOffset,
      );
      if (recovered) turnContextModel = recovered;
    }
    let sessionUuid: string | null = meta.sessionId;

    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (obj.type === 'session_meta') {
        const payload = obj.payload as SessionMeta;
        sessionUuid = payload.id ?? sessionUuid;
      }

      if (
        obj.type === 'turn_context' ||
        obj.type === 'thread_settings_applied' ||
        obj.type === 'world_state'
      ) {
        const model = modelFromRolloutEvent(obj);
        if (model) turnContextModel = model;
        continue;
      }

      const tokenEvent = extractTokenCount(obj);
      if (!tokenEvent?.info) continue;

      const info = tokenEvent.info;
      const lastUsage = info.last_token_usage as TokenUsage | undefined;
      const totalUsage = info.total_token_usage as TokenUsage | undefined;
      const modelKey = readModel(info.model) ?? turnContextModel;
      const prevTotals = prevTotalMap.get(modelKey);
      const rawUsage = pickDelta(lastUsage, totalUsage, prevTotals);
      if (totalUsage) prevTotalMap.set(modelKey, { ...totalUsage });

      const isReplayedHistory = tokenCountSeen < replayTokenCountToSkip;
      tokenCountSeen += 1;

      const snapshot = totalUsage
        ? [
            totalUsage.input_tokens,
            totalUsage.cached_input_tokens ??
              totalUsage.cache_read_input_tokens,
            totalUsage.cache_creation_input_tokens,
            totalUsage.output_tokens,
            totalUsage.reasoning_output_tokens,
            totalUsage.total_tokens,
          ]
            .map((value) => value ?? 0)
            .join('|') +
          ':' +
          modelKey
        : undefined;
      const repeated = snapshot !== undefined && snapshot === lastUsageSnapshot;
      lastUsageSnapshot = snapshot;
      if (isReplayedHistory || !rawUsage || repeated) continue;

      const delta = normalizeCodexUsage(rawUsage);
      if (!delta) continue;

      const ts = tokenEvent.timestamp;
      if (!ts) continue;
      const hourStart = toUtcHalfHourStart(ts);
      if (!hourStart || new Date(hourStart).getTime() < sinceMs) continue;

      const dedupKey =
        sessionUuid && ts ? `${sessionUuid}:event:${tokenCountSeen}` : null;
      if (
        dedupKey &&
        (seenHashes.has(dedupKey) ||
          (startOffset === 0 && seenHashes.has(`${sessionUuid}:${ts}`)))
      )
        continue;
      if (dedupKey) seenHashes.add(dedupKey);

      const identifiable =
        !!lastUsage && Object.keys(lastUsage).length > 0 && !!sessionUuid;
      const validCache =
        validUsageFields(
          [rawUsage.input_tokens],
          [
            rawUsage.cached_input_tokens,
            rawUsage.cache_read_input_tokens,
            rawUsage.cache_creation_input_tokens,
          ],
        ) &&
        (rawUsage.cached_input_tokens ??
          rawUsage.cache_read_input_tokens ??
          0) <= rawUsage.input_tokens!;
      delta.local_metrics = localEvidence(
        identifiable ? 1 : 0,
        identifiable,
        validCache,
        validCache,
      );
      const model = readModel(info.model) ?? turnContextModel;
      accumulateBucket(
        bucketState,
        'codex',
        model,
        meta.sessionProject,
        hourStart,
        delta,
      );
      eventsParsed += 1;
    }

    const prevTotalSave: CodexFileCursor['prevTotal'] = {};
    for (const [k, v] of prevTotalMap.entries()) {
      prevTotalSave[k] = { ...v };
    }

    codexCursor.files[filePath] = {
      inode,
      offset: st.size,
      tokenCountSeen,
      lastUsageSnapshot,
      prevTotal: prevTotalSave,
      lastModel: turnContextModel,
      meta,
    };
    filesProcessed += 1;
  }

  codexCursor.seenHashes = Array.from(seenHashes);

  const buckets = bucketsFromState(bucketState, 'codex');
  return {
    result: { buckets, eventsParsed, filesProcessed },
    cursors,
  };
}

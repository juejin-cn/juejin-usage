import { localEvidence, validUsageFields } from '../local-metrics.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import {
  opencodeDataDir,
  opencodeDbPath,
  opencodeMessagesDir,
} from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  type BucketAccumulator,
} from './shared.js';
import { queryDbJson } from './sqlite.js';
import { diffGeminiTotals, sameGeminiTotals } from './gemini.js';

export const OPENCODE_COLLECTOR = 'opencode';

type OpencodeTotals = Omit<TokenTotals, 'conversation_count'>;

export function normalizeOpencodeTokens(
  tokens: Record<string, unknown> | null | undefined,
): OpencodeTotals | null {
  if (!tokens || typeof tokens !== 'object') return null;
  const input = Math.max(0, Math.floor(Number(tokens.input) || 0));
  const output = Math.max(0, Math.floor(Number(tokens.output) || 0));
  const reasoning = Math.max(0, Math.floor(Number(tokens.reasoning) || 0));
  const cache = tokens.cache as { read?: number; write?: number } | undefined;
  const cached = Math.max(0, Math.floor(Number(cache?.read) || 0));
  const cacheWrite = Math.max(0, Math.floor(Number(cache?.write) || 0));
  const total = input + output + reasoning + cached + cacheWrite;
  if (total === 0) return null;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
    local_metrics: localEvidence(
      0,
      false,
      validUsageFields([tokens.input], [cache?.read, cache?.write]),
      validUsageFields([tokens.input], [cache?.read, cache?.write]),
    ),
  };
}

export function deriveOpencodeMessageKey(
  sessionId: string | null | undefined,
  msgId: string | null | undefined,
): string | null {
  if (!sessionId || !msgId) return null;
  return `${sessionId}|${msgId}`;
}

function coerceEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(value);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

function projectFromRoot(rootPath: unknown): string {
  if (typeof rootPath !== 'string' || !rootPath.trim()) return 'unknown';
  return resolveProjectName(rootPath);
}

function ingestMessage(
  opts: {
    messageKey: string | null;
    currentTotals: OpencodeTotals;
    model: string;
    project: string;
    timestampMs: number | null;
    sinceMs: number;
    messageIndex: Record<string, { lastTotals: OpencodeTotals }>;
    bucketState: BucketAccumulator;
  },
): number {
  const {
    messageKey,
    currentTotals,
    model,
    project,
    timestampMs,
    sinceMs,
    messageIndex,
    bucketState,
  } = opts;

  const prev = messageKey ? messageIndex[messageKey]?.lastTotals : undefined;
  const delta = diffGeminiTotals(currentTotals, prev);
  if (messageKey) {
    if (!sameGeminiTotals(currentTotals, prev)) {
      messageIndex[messageKey] = { lastTotals: currentTotals };
    }
  }
  if (!delta) return 0;
  if (!timestampMs) return 0;

  const tsIso = new Date(timestampMs).toISOString();
  const hourStart = toUtcHalfHourStart(tsIso);
  if (!hourStart) return 0;
  if (new Date(hourStart).getTime() < sinceMs) return 0;

  accumulateBucket(
    bucketState,
    'opencode',
    model || 'unknown',
    project,
    hourStart,
    {
      ...delta,
      conversation_count: 1,
      local_metrics: localEvidence(
        messageKey && !prev ? 1 : 0,
        !!messageKey,
        currentTotals.local_metrics?.cacheReadComplete ?? false,
        currentTotals.local_metrics?.cacheWriteComplete ?? false,
      ),
    },
    OPENCODE_COLLECTOR,
  );
  return 1;
}

function parseFromSqlite(
  dbPath: string,
  sinceMs: number,
  messageIndex: Record<string, { lastTotals: OpencodeTotals }>,
  bucketState: BucketAccumulator,
): { eventsParsed: number; filesProcessed: number } {
  const query = `SELECT
    id as id,
    session_id as sessionID,
    json_extract(data, '$.role') as role,
    json_extract(data, '$.time.created') as created,
    json_extract(data, '$.time.completed') as completed,
    json_extract(data, '$.modelID') as modelID,
    json_extract(data, '$.model') as model,
    json_extract(data, '$.modelId') as modelId,
    json_extract(data, '$.tokens') as tokens,
    json_extract(data, '$.path.root') as rootPath,
    json_extract(data, '$.path.cwd') as cwdPath
    FROM message
    WHERE json_extract(data, '$.role') = 'assistant'`;

  let rows: Record<string, unknown>[];
  try {
    rows = queryDbJson(dbPath, query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|sqlite3 CLI not found/i.test(msg)) {
      throw new Error(
        'sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync opencode data.',
      );
    }
    throw err;
  }

  let eventsParsed = 0;
  for (const row of rows) {
    let tokens: Record<string, unknown> | null = null;
    try {
      tokens =
        typeof row.tokens === 'string'
          ? (JSON.parse(row.tokens) as Record<string, unknown>)
          : (row.tokens as Record<string, unknown> | null);
    } catch {
      continue;
    }
    const currentTotals = normalizeOpencodeTokens(tokens);
    if (!currentTotals) continue;

    const sessionId = typeof row.sessionID === 'string' ? row.sessionID : null;
    const msgId = typeof row.id === 'string' ? row.id : null;
    const messageKey = deriveOpencodeMessageKey(sessionId, msgId);
    const model =
      (typeof row.modelID === 'string' && row.modelID) ||
      (typeof row.model === 'string' && row.model) ||
      (typeof row.modelId === 'string' && row.modelId) ||
      'unknown';
    const project = projectFromRoot(row.rootPath ?? row.cwdPath);
    const timestampMs =
      coerceEpochMs(row.completed) || coerceEpochMs(row.created);

    eventsParsed += ingestMessage({
      messageKey,
      currentTotals,
      model,
      project,
      timestampMs,
      sinceMs,
      messageIndex,
      bucketState,
    });
  }

  return { eventsParsed, filesProcessed: rows.length > 0 ? 1 : 0 };
}

function walkMessageFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkMessageFiles(full, out);
    } else if (e.name.endsWith('.json') && (e.name.startsWith('msg_') || e.name.includes('msg'))) {
      out.push(full);
    } else if (e.name.endsWith('.json')) {
      out.push(full);
    }
  }
}

function parseFromJson(
  messagesDir: string,
  sinceMs: number,
  messageIndex: Record<string, { lastTotals: OpencodeTotals }>,
  bucketState: BucketAccumulator,
): { eventsParsed: number; filesProcessed: number } {
  if (!existsSync(messagesDir)) return { eventsParsed: 0, filesProcessed: 0 };

  const files: string[] = [];
  walkMessageFiles(messagesDir, files);

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of files) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    filesProcessed += 1;

    if (data.role !== 'assistant') continue;
    const currentTotals = normalizeOpencodeTokens(
      data.tokens as Record<string, unknown> | undefined,
    );
    if (!currentTotals) continue;

    const sessionId =
      (typeof data.sessionID === 'string' && data.sessionID) ||
      (typeof data.sessionId === 'string' && data.sessionId) ||
      basename(join(filePath, '..'));
    const msgId =
      (typeof data.id === 'string' && data.id) || basename(filePath, '.json');
    const messageKey = deriveOpencodeMessageKey(sessionId, msgId);
    const model =
      (typeof data.modelID === 'string' && data.modelID) ||
      (typeof data.model === 'string' && data.model) ||
      (typeof data.modelId === 'string' && data.modelId) ||
      'unknown';
    const pathObj = data.path as { root?: string; cwd?: string } | undefined;
    const project = projectFromRoot(pathObj?.root ?? pathObj?.cwd);
    const time = data.time as { created?: unknown; completed?: unknown } | undefined;
    const timestampMs = coerceEpochMs(time?.completed) || coerceEpochMs(time?.created);

    eventsParsed += ingestMessage({
      messageKey,
      currentTotals,
      model,
      project,
      timestampMs,
      sinceMs,
      messageIndex,
      bucketState,
    });
  }

  return { eventsParsed, filesProcessed };
}

export interface ParseOpencodeResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseOpencodeIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseOpencodeResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  if (!cursors.opencode) {
    cursors.opencode = { messages: {} };
  }
  const messageIndex = cursors.opencode.messages;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  const dbPath = opencodeDbPath();
  const dataDir = opencodeDataDir();
  void dataDir;

  if (existsSync(dbPath)) {
    try {
      const parsed = parseFromSqlite(dbPath, sinceMs, messageIndex, bucketState);
      eventsParsed += parsed.eventsParsed;
      filesProcessed += parsed.filesProcessed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fall through to JSON if DB unreadable; surface sqlite-missing as skip.
      if (/sqlite3 CLI not found/i.test(msg)) {
        return {
          result: {
            buckets: [],
            eventsParsed: 0,
            filesProcessed: 0,
            skipped: true,
            error: msg,
          },
          cursors,
        };
      }
      const json = parseFromJson(opencodeMessagesDir(), sinceMs, messageIndex, bucketState);
      eventsParsed += json.eventsParsed;
      filesProcessed += json.filesProcessed;
    }
  } else {
    const json = parseFromJson(opencodeMessagesDir(), sinceMs, messageIndex, bucketState);
    eventsParsed += json.eventsParsed;
    filesProcessed += json.filesProcessed;
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'opencode'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

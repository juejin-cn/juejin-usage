import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { localEvidence } from '../local-metrics.js';
import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  type BucketAccumulator,
} from './shared.js';
import { queryDbJson, readSqliteWithSnapshot, sqliteTableExists } from './sqlite.js';
import { diffGeminiTotals, sameGeminiTotals } from './gemini.js';
import {
  deriveOpencodeMessageKey,
  normalizeOpencodeTokens,
  opencodeModelName,
} from './opencode.js';

export const CODEARTS_AGENT_COLLECTOR = 'codearts-agent';

type CodeartsAgentTotals = Omit<TokenTotals, 'conversation_count'>;

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

function projectFromMessage(data: Record<string, unknown>): string {
  const pathObj = data.path as { root?: string; cwd?: string } | undefined;
  const root = pathObj?.root ?? pathObj?.cwd;
  if (typeof root === 'string' && root.trim()) {
    return resolveProjectName(root);
  }
  return 'unknown';
}

/** CodeArts Agent data root (`~/.codeartsdoer/codearts-data` or `$CODEARTS_DATA_HOME`). */
export function codeartsAgentDataDir(): string {
  const env = process.env.CODEARTS_DATA_HOME?.trim();
  if (env) {
    return env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
  }
  return join(homedir(), '.codeartsdoer', 'codearts-data');
}

/** CodeArts Agent SQLite DB path (CODEARTS_AGENT_DB override for tests). */
export function codeartsAgentDbPath(): string {
  const explicit = process.env.CODEARTS_AGENT_DB?.trim();
  if (explicit) {
    return explicit.startsWith('~') ? join(homedir(), explicit.slice(1)) : explicit;
  }
  return join(codeartsAgentDataDir(), 'opencode.db');
}

function ingestMessage(
  opts: {
    messageKey: string | null;
    currentTotals: CodeartsAgentTotals;
    model: string;
    project: string;
    timestampMs: number | null;
    sinceMs: number;
    messageIndex: Record<string, { lastTotals: CodeartsAgentTotals }>;
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
  if (messageKey && !sameGeminiTotals(currentTotals, prev)) {
    messageIndex[messageKey] = { lastTotals: currentTotals };
  }
  if (!delta) return 0;
  if (!timestampMs) return 0;

  const tsIso = new Date(timestampMs).toISOString();
  const hourStart = toUtcHalfHourStart(tsIso);
  if (!hourStart) return 0;
  if (new Date(hourStart).getTime() < sinceMs) return 0;

  accumulateBucket(
    bucketState,
    'codearts-agent',
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
    CODEARTS_AGENT_COLLECTOR,
  );
  return 1;
}

function messageSelect(alias: string, origin: string): string {
  return `'${origin}' as origin,
    ${alias}.id as id,
    ${alias}.session_id as session_id,
    json_extract(${alias}.data, '$.time.created') as created,
    json_extract(${alias}.data, '$.time.completed') as completed,
    json_extract(${alias}.data, '$.modelID') as modelID,
    json_extract(${alias}.data, '$.model.id') as modelObjectId,
    json_extract(${alias}.data, '$.model') as model,
    json_extract(${alias}.data, '$.modelId') as modelId,
    json_extract(${alias}.data, '$.tokens') as tokens,
    json_extract(${alias}.data, '$.path.root') as rootPath,
    json_extract(${alias}.data, '$.path.cwd') as cwdPath,
    ${alias}.data as data`;
}

/**
 * CodeArts Agent embeds the OpenCode engine, so its `opencode.db` uses the
 * same shape: v1 `message` rows and/or the v2 `session_message` projection.
 * During an upstream upgrade both coexist while v2 backfills, so read every
 * table that exists and decide per row later whether a valid v2 call replaces
 * its legacy row.
 */
function usageQuery(dbPath: string): string | null {
  const queries: string[] = [];
  if (sqliteTableExists(dbPath, 'session_message')) {
    queries.push(`SELECT ${messageSelect('sm', 'v2')}
      FROM session_message sm
      WHERE sm.type IN ('assistant', 'compaction')`);
  }
  if (sqliteTableExists(dbPath, 'message')) {
    queries.push(`SELECT ${messageSelect('m', 'legacy')}
      FROM message m
      WHERE json_extract(m.data, '$.role') = 'assistant'`);
  }
  return queries.length > 0 ? queries.join(' UNION ALL ') : null;
}

interface ParsedUsageRow {
  origin: string;
  messageKey: string | null;
  currentTotals: CodeartsAgentTotals;
  model: string;
  project: string;
  timestampMs: number | null;
}

function parseFromSqlite(
  dbPath: string,
  sinceMs: number,
  messageIndex: Record<string, { lastTotals: CodeartsAgentTotals }>,
  bucketState: BucketAccumulator,
): { eventsParsed: number; filesProcessed: number } {
  const query = usageQuery(dbPath);
  if (!query) return { eventsParsed: 0, filesProcessed: 0 };

  let rows: Record<string, unknown>[];
  try {
    rows = readSqliteWithSnapshot(dbPath, (snap) => queryDbJson(snap, query));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|sqlite3 CLI not found/i.test(msg)) {
      throw new Error(
        'sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync CodeArts Agent data.',
      );
    }
    throw err;
  }

  const parsed: ParsedUsageRow[] = [];
  const v2UsageKeys = new Set<string>();

  for (const row of rows) {
    let data: Record<string, unknown> | null = null;
    try {
      data =
        typeof row.data === 'string'
          ? (JSON.parse(row.data) as Record<string, unknown>)
          : (row.data as Record<string, unknown> | null);
    } catch {
      continue;
    }
    if (!data) continue;

    let tokens: Record<string, unknown> | null = null;
    try {
      tokens =
        typeof row.tokens === 'string'
          ? (JSON.parse(row.tokens) as Record<string, unknown>)
          : (row.tokens as Record<string, unknown> | null);
    } catch {
      tokens = (data.tokens as Record<string, unknown> | undefined) ?? null;
    }

    const currentTotals = normalizeOpencodeTokens(tokens);
    if (!currentTotals) continue;

    const sessionId =
      (typeof row.session_id === 'string' && row.session_id) ||
      (typeof data.sessionID === 'string' && data.sessionID) ||
      null;
    const msgId =
      (typeof row.id === 'string' && row.id) ||
      (typeof data.id === 'string' && data.id) ||
      null;
    const messageKey = deriveOpencodeMessageKey(sessionId, msgId);
    const origin = typeof row.origin === 'string' ? row.origin : 'legacy';
    if (origin === 'v2' && messageKey) v2UsageKeys.add(messageKey);
    const project = projectFromMessage(data);
    const timestampMs =
      coerceEpochMs(row.completed) ||
      coerceEpochMs(data.time && typeof data.time === 'object'
        ? (data.time as { completed?: unknown }).completed
        : null) ||
      coerceEpochMs(row.created) ||
      coerceEpochMs(data.time && typeof data.time === 'object'
        ? (data.time as { created?: unknown }).created
        : null);

    parsed.push({
      origin,
      messageKey,
      currentTotals,
      model: opencodeModelName(row),
      project,
      timestampMs,
    });
  }

  let eventsParsed = 0;
  for (const row of parsed) {
    // A pending projection, a non-call event, or a row without usable tokens
    // must not hide legacy usage for the same message.
    if (row.origin === 'legacy' && row.messageKey && v2UsageKeys.has(row.messageKey)) {
      continue;
    }
    eventsParsed += ingestMessage({
      messageKey: row.messageKey,
      currentTotals: row.currentTotals,
      model: row.model,
      project: row.project,
      timestampMs: row.timestampMs,
      sinceMs,
      messageIndex,
      bucketState,
    });
  }

  return { eventsParsed, filesProcessed: rows.length > 0 ? 1 : 0 };
}

export interface ParseCodeartsAgentResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseCodeartsAgentIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseCodeartsAgentResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  if (!cursors.codeartsAgent) {
    cursors.codeartsAgent = { messages: {} };
  }
  if (!cursors.codeartsAgent.messages) {
    cursors.codeartsAgent.messages = {};
  }
  const messageIndex = cursors.codeartsAgent.messages;
  const bucketState: BucketAccumulator = new Map();

  const dbPath = codeartsAgentDbPath();
  if (!existsSync(dbPath)) {
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0 },
      cursors,
    };
  }

  try {
    const parsed = parseFromSqlite(dbPath, sinceMs, messageIndex, bucketState);
    return {
      result: {
        buckets: bucketsFromState(bucketState, 'codearts-agent'),
        eventsParsed: parsed.eventsParsed,
        filesProcessed: parsed.filesProcessed,
      },
      cursors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
    throw err;
  }
}

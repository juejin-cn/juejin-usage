/**
 * paths.ts exports needed:
 *   zcodeDbPath(): string  — $ZCODE_HOME/cli/db/db.sqlite or ~/.zcode/cli/db/db.sqlite
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
import { deriveOpencodeMessageKey, normalizeOpencodeTokens } from './opencode.js';

export const ZCODE_COLLECTOR = 'zcode';
const MAX_RETAINED_MESSAGE_SNAPSHOTS = 50_000;

type ZcodeTotals = Omit<TokenTotals, 'conversation_count'>;

/** Block bundled Claude/Codex/Gemini sub-agents (counted by their own parsers). */
export function isZcodeNativeMessage(data: Record<string, unknown> | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  // ZCode renamed providerID -> providerId in newer builds; accept both.
  const provider = String(data.providerID ?? data.providerId ?? '').toLowerCase();
  if (!provider) return false;
  return !(
    provider.includes('anthropic') ||
    provider.includes('openai') ||
    provider.includes('google')
  );
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

function projectFromMessage(data: Record<string, unknown>): string {
  const pathObj = data.path as { root?: string; cwd?: string } | undefined;
  const root = pathObj?.root ?? pathObj?.cwd;
  if (typeof root === 'string' && root.trim()) {
    return resolveProjectName(root);
  }
  return 'unknown';
}

/** ZCode SQLite DB path ($ZCODE_HOME or ~/.zcode). */
export function zcodeDbPath(): string {
  const env = process.env.ZCODE_HOME?.trim();
  const home = env
    ? env.startsWith('~')
      ? join(homedir(), env.slice(1))
      : env
    : join(homedir(), '.zcode');
  return join(home, 'cli', 'db', 'db.sqlite');
}

function ingestMessage(
  opts: {
    messageKey: string | null;
    currentTotals: ZcodeTotals;
    model: string;
    project: string;
    timestampMs: number | null;
    sinceMs: number;
    messageIndex: Record<string, { lastTotals: ZcodeTotals }>;
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
    'zcode',
    model || 'unknown',
    project,
    hourStart,
    { ...delta, conversation_count: 1 },
    ZCODE_COLLECTOR,
  );
  return 1;
}

function numField(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function capRetainedMessageSnapshots(
  messageIndex: Record<string, { lastTotals: ZcodeTotals }>,
): void {
  const messageKeys = Object.keys(messageIndex);
  if (messageKeys.length <= MAX_RETAINED_MESSAGE_SNAPSHOTS) return;

  const excessMessageCount = messageKeys.length - MAX_RETAINED_MESSAGE_SNAPSHOTS;
  for (const messageKey of messageKeys.slice(0, excessMessageCount)) {
    delete messageIndex[messageKey];
  }
}

/**
 * ZCode's normalized usage convention (see model_usage.raw_usage_json):
 * input_tokens already includes cache read/write, and computed_total_tokens
 * is the provider-reported total (input + output, excluding reasoning).
 * Reasoning is reported separately, so the bucket total adds it back on top
 * to keep the five-field-sum convention every other parser (and the server's
 * ingest recompute) follows.
 */
function totalsFromUsageRow(row: Record<string, unknown>): ZcodeTotals | null {
  const input = numField(row.input_tokens);
  const output = numField(row.output_tokens);
  const reasoning = numField(row.reasoning_tokens);
  const cacheRead = numField(row.cache_read_input_tokens);
  const cacheWrite = numField(row.cache_creation_input_tokens);
  const total =
    (numField(row.computed_total_tokens) || input + output) + reasoning;
  if (total <= 0) return null;
  return {
    input_tokens: Math.max(0, input - cacheRead - cacheWrite),
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

function parseFromUsageTable(
  dbPath: string,
  sinceMs: number,
  messageIndex: Record<string, { lastTotals: ZcodeTotals }>,
  bucketState: BucketAccumulator,
): { eventsParsed: number; filesProcessed: number } {
  // model_usage is append-only and per-request; joining message gives the
  // project path without needing session lookup.
  const query = `SELECT
    u.id,
    u.session_id,
    u.model_id,
    u.started_at,
    u.completed_at,
    u.input_tokens,
    u.output_tokens,
    u.reasoning_tokens,
    u.cache_creation_input_tokens,
    u.cache_read_input_tokens,
    u.computed_total_tokens,
    json_extract(m.data, '$.path.root') AS rootPath
    FROM model_usage u
    LEFT JOIN message m ON m.id = u.assistant_message_id
    WHERE u.computed_total_tokens > 0`;

  const rows = readSqliteWithSnapshot(dbPath, (snap) => queryDbJson(snap, query));

  let eventsParsed = 0;
  for (const row of rows) {
    const currentTotals = totalsFromUsageRow(row);
    if (!currentTotals) continue;

    const usageId = typeof row.id === 'string' ? row.id : null;
    const sessionId = typeof row.session_id === 'string' ? row.session_id : null;
    const messageKey = usageId
      ? sessionId
        ? `usage|${sessionId}|${usageId}`
        : `usage|${usageId}`
      : null;
    const model = (typeof row.model_id === 'string' && row.model_id) || 'unknown';
    const project =
      typeof row.rootPath === 'string' && row.rootPath.trim()
        ? resolveProjectName(row.rootPath)
        : 'unknown';
    const timestampMs =
      coerceEpochMs(row.completed_at) || coerceEpochMs(row.started_at);

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

function parseFromSqlite(
  dbPath: string,
  sinceMs: number,
  messageIndex: Record<string, { lastTotals: ZcodeTotals }>,
  bucketState: BucketAccumulator,
): { eventsParsed: number; filesProcessed: number } {
  const query = `SELECT
    id,
    session_id,
    json_extract(data, '$.role') as role,
    json_extract(data, '$.time.created') as created,
    json_extract(data, '$.time.completed') as completed,
    json_extract(data, '$.modelID') as modelID,
    json_extract(data, '$.model') as model,
    json_extract(data, '$.modelId') as modelId,
    json_extract(data, '$.providerID') as providerID,
    json_extract(data, '$.tokens') as tokens,
    json_extract(data, '$.path.root') as rootPath,
    json_extract(data, '$.path.cwd') as cwdPath,
    data
    FROM message
    WHERE json_extract(data, '$.role') = 'assistant'`;

  let rows: Record<string, unknown>[];
  try {
    rows = readSqliteWithSnapshot(dbPath, (snap) => queryDbJson(snap, query));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|sqlite3 CLI not found/i.test(msg)) {
      throw new Error(
        'sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync ZCode data.',
      );
    }
    throw err;
  }

  let eventsParsed = 0;
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
    if (!data || !isZcodeNativeMessage(data)) continue;

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
    const msgId = (typeof row.id === 'string' && row.id) || (typeof data.id === 'string' && data.id) || null;
    const messageKey = deriveOpencodeMessageKey(sessionId, msgId);
    const model =
      (typeof row.modelID === 'string' && row.modelID) ||
      (typeof row.model === 'string' && row.model) ||
      (typeof row.modelId === 'string' && row.modelId) ||
      (typeof data.modelID === 'string' && data.modelID) ||
      'unknown';
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

export interface ParseZcodeResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseZcodeIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseZcodeResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const zcode = (cursors as CursorsFile & { zcode?: { messages: Record<string, { lastTotals: ZcodeTotals }> } })
    .zcode;
  if (!zcode) {
    (cursors as CursorsFile & { zcode: { messages: Record<string, { lastTotals: ZcodeTotals }> } }).zcode = {
      messages: {},
    };
  }
  const messageIndex = (
    cursors as CursorsFile & { zcode: { messages: Record<string, { lastTotals: ZcodeTotals }> } }
  ).zcode.messages;
  const bucketState: BucketAccumulator = new Map();

  const dbPath = zcodeDbPath();
  if (!existsSync(dbPath)) {
    capRetainedMessageSnapshots(messageIndex);
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0 },
      cursors,
    };
  }

  try {
    // Newer ZCode builds log usage in a dedicated model_usage table; fall
    // back to assistant-message JSON for older versions.
    const parsed = sqliteTableExists(dbPath, 'model_usage')
      ? parseFromUsageTable(dbPath, sinceMs, messageIndex, bucketState)
      : parseFromSqlite(dbPath, sinceMs, messageIndex, bucketState);
    capRetainedMessageSnapshots(messageIndex);
    return {
      result: {
        buckets: bucketsFromState(bucketState, 'zcode'),
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

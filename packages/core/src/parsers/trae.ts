import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import {
  DEFAULT_DATA_DIR,
  traeAgentDbEntries,
  traeSqlcipherKeyPath,
} from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
} from './shared.js';
import { queryDbJson, readSqliteWithSnapshot } from './sqlite.js';
import {
  decryptTraeDatabaseToTemp,
  loadTraeSqlcipherKeyFile,
  verifyTraeSqlcipherKey,
} from './trae-decrypt.js';

export const TRAE_COLLECTOR_IDE = 'trae-ide';
export const TRAE_COLLECTOR_CN_IDE = 'trae-cn-ide';

interface TraeTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface TraeTurnContext {
  token_usage?: TraeTokenUsage;
  persist_user_message_context?: {
    model_info?: { config_name?: string; model?: string };
  };
  model_info?: { config_name?: string; model?: string };
}

function normalizeTraeUsage(u: TraeTokenUsage): TokenTotals | null {
  const cacheRead = Math.max(0, Number(u.cache_read_input_tokens) || 0);
  const cacheCreation = Math.max(0, Number(u.cache_creation_input_tokens) || 0);
  const prompt = Math.max(0, Number(u.prompt_tokens) || 0);
  // Trae prompt_tokens is full prompt (includes cache reads); non-cached input =
  // prompt - cache_read when that stays non-negative.
  const input = Math.max(0, prompt - cacheRead);
  const output = Math.max(0, Number(u.completion_tokens) || 0);
  const reasoning = Math.max(0, Number(u.reasoning_tokens) || 0);
  const delta = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    reasoning_output_tokens: reasoning,
  };
  const total = computeTotalTokens(delta);
  if (total === 0) return null;
  return { ...delta, total_tokens: total, conversation_count: 1 };
}

function extractModel(ctx: TraeTurnContext): string {
  return (
    ctx.persist_user_message_context?.model_info?.config_name ||
    ctx.persist_user_message_context?.model_info?.model ||
    ctx.model_info?.config_name ||
    ctx.model_info?.model ||
    'unknown'
  );
}

function resolveTs(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function parseTurnsFromPlainDb(
  dbPath: string,
  collector: string,
  sinceMs: number,
  seenHashes: Set<string>,
  bucketState: BucketAccumulator,
): number {
  // Keep SELECT to columns that exist across Trae builds; optional fields
  // are best-effort via follow-up queries if needed.
  const sqlVariants = [
    `SELECT id AS id, context AS context, created_at AS created_at, project_path AS project_path
     FROM chat_turn WHERE context IS NOT NULL AND length(context) > 2`,
    `SELECT id AS id, context AS context, gmt_create AS created_at, project_path AS project_path
     FROM chat_turn WHERE context IS NOT NULL AND length(context) > 2`,
    `SELECT id AS id, context AS context, created_at AS created_at
     FROM chat_turn WHERE context IS NOT NULL AND length(context) > 2`,
    `SELECT id AS id, context AS context, gmt_create AS created_at
     FROM chat_turn WHERE context IS NOT NULL AND length(context) > 2`,
  ];

  let rows: Record<string, unknown>[] = [];
  for (const sql of sqlVariants) {
    try {
      rows = readSqliteWithSnapshot(dbPath, (snap) => queryDbJson(snap, sql));
      break;
    } catch {
      // try next shape
    }
  }
  if (rows.length === 0) {
    // Last resort: no timestamp column — cannot bucket reliably.
    return 0;
  }

  let eventsParsed = 0;
  for (const row of rows) {
    const id = row.id != null ? String(row.id) : null;
    const dedup = id ? `${collector}:${id}` : null;
    if (dedup && seenHashes.has(dedup)) continue;

    const contextRaw = row.context;
    if (typeof contextRaw !== 'string') continue;
    let ctx: TraeTurnContext;
    try {
      ctx = JSON.parse(contextRaw) as TraeTurnContext;
    } catch {
      continue;
    }
    if (!ctx.token_usage) continue;
    const delta = normalizeTraeUsage(ctx.token_usage);
    if (!delta) continue;

    const iso = resolveTs(row.created_at) ?? resolveTs(row.gmt_create);
    if (!iso) continue;
    const hourStart = toUtcHalfHourStart(iso);
    if (!hourStart) continue;
    if (new Date(hourStart).getTime() < sinceMs) continue;

    const model = extractModel(ctx);
    const project =
      (typeof row.project_path === 'string' &&
        row.project_path &&
        resolveProjectName(row.project_path)) ||
      (typeof row.project_id === 'string' && row.project_id) ||
      'unknown';

    accumulateBucket(bucketState, 'trae', model, project, hourStart, delta, collector);
    if (dedup) seenHashes.add(dedup);
    eventsParsed += 1;
  }
  return eventsParsed;
}

/**
 * Optional override for tests / users who already decrypted:
 * `TRAE_DECRYPTED_DB_<COLLECTOR>` e.g. TRAE_DECRYPTED_DB_trae-cn-ide=/path/to.db
 */
function envDecryptedDbPath(collector: string): string | null {
  const key = `TRAE_DECRYPTED_DB_${collector.replace(/-/g, '_').toUpperCase()}`;
  const v = process.env[key]?.trim();
  return v || null;
}

export interface ParseTraeResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export interface ParseTraeOptions {
  skipGlobal?: boolean;
  /** Override data dir for key cache (defaults to ~/.ai-usage). */
  dataDir?: string;
}

export async function parseTraeIncremental(
  cursors: CursorsFile,
  statsSince: string,
  options?: ParseTraeOptions,
): Promise<{ result: ParseTraeResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;

  if (!cursors.trae) {
    cursors.trae = { seenHashes: [], lastError: null };
  }
  const trae = cursors.trae;
  const seenHashes = new Set(trae.seenHashes ?? []);
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;
  const missingKeys: string[] = [];
  const errors: string[] = [];

  for (const entry of traeAgentDbEntries()) {
    if (options?.skipGlobal && entry.collector === TRAE_COLLECTOR_IDE) continue;
    const envPath = envDecryptedDbPath(entry.collector);
    const encryptedExists = existsSync(entry.dbPath);

    if (envPath && existsSync(envPath)) {
      eventsParsed += parseTurnsFromPlainDb(
        envPath,
        entry.collector,
        sinceMs,
        seenHashes,
        bucketState,
      );
      filesProcessed += 1;
      continue;
    }

    if (!encryptedExists) continue;

    const keyPath = traeSqlcipherKeyPath(dataDir, entry.collector);
    const key = loadTraeSqlcipherKeyFile(keyPath);
    if (!key) {
      missingKeys.push(entry.collector);
      continue;
    }
    if (!verifyTraeSqlcipherKey(entry.dbPath, key)) {
      errors.push(`${entry.collector}: SQLCipher key failed verification`);
      continue;
    }

    let decryptedPath: string | null = null;
    try {
      decryptedPath = await decryptTraeDatabaseToTemp(entry.dbPath, key);
      eventsParsed += parseTurnsFromPlainDb(
        decryptedPath,
        entry.collector,
        sinceMs,
        seenHashes,
        bucketState,
      );
      filesProcessed += 1;
    } catch (err) {
      errors.push(
        `${entry.collector}: decrypt failed (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      if (decryptedPath) await unlink(decryptedPath).catch(() => undefined);
    }
  }

  trae.seenHashes = Array.from(seenHashes).slice(-50_000);

  const hasAnyDb = traeAgentDbEntries().some((e) => !(options?.skipGlobal && e.collector === TRAE_COLLECTOR_IDE) && existsSync(e.dbPath));
  if (!hasAnyDb && filesProcessed === 0) {
    trae.lastError = null;
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0 },
      cursors,
    };
  }

  if (filesProcessed === 0 && (missingKeys.length > 0 || errors.length > 0)) {
    const parts = [
      ...missingKeys.map(
        (c) =>
          `${c}: place SQLCipher key at ${traeSqlcipherKeyPath(dataDir, c)} (see trae-db-recovery)`,
      ),
      ...errors,
    ];
    const error = parts.join('; ');
    trae.lastError = error;
    return {
      result: {
        buckets: [],
        eventsParsed: 0,
        filesProcessed: 0,
        skipped: true,
        error,
      },
      cursors,
    };
  }

  trae.lastError = errors.length > 0 ? errors.join('; ') : null;

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'trae'),
      eventsParsed,
      filesProcessed,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    },
    cursors,
  };
}

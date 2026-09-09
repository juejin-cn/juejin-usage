import { localEvidence, validUsageFields } from '../local-metrics.js';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { cursorCliConfigPath, cursorStateVscdbPath } from '../paths.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketStateKey,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
} from './shared.js';
import { isSqliteLockError, queryDbJson, readSqliteWithSnapshot } from './sqlite.js';

const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const SESSION_COOKIE = 'WorkosCursorSessionToken';
const FETCH_TIMEOUT_MS = 30_000;

/** Re-read the session cookie from state.vscdb at most this often (invalidated on 401). */
const COOKIE_CACHE_TTL_MS = 30 * 60_000;

let cookieCache: { cookie: string; cachedAt: number } | null = null;

/** Test seam. */
export function resetCursorCookieCache(): void {
  cookieCache = null;
}

const WORKOS_OAUTH_SUBJECT_RE = /^(google-oauth2|github|oidc|auth0)\|[^|]+$/;

export class CursorNotLoggedInError extends Error {
  skip = true;
  constructor(message = 'Cursor 未登录，请在 Cursor 中重新登录') {
    super(message);
    this.name = 'CursorNotLoggedInError';
  }
}

export class CursorSyncSkippedError extends Error {
  skip = true;
  constructor(message: string) {
    super(message);
    this.name = 'CursorSyncSkippedError';
  }
}

function normalizeCursorSubject(subject: string): string | null {
  if (!subject) return null;
  const native = subject.match(/\|(user_[A-Za-z0-9_]+)$/);
  if (native) return native[1]!;
  if (WORKOS_OAUTH_SUBJECT_RE.test(subject)) return subject;
  return null;
}

function extractUserIdFromCliConfig(configPath: string): string | null {
  try {
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as { authInfo?: { authId?: string } };
    return normalizeCursorSubject(config.authInfo?.authId ?? '');
  } catch {
    return null;
  }
}

function extractUserIdFromJwt(jwt: string): string | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { sub?: string };
    return normalizeCursorSubject(payload.sub ?? '');
  } catch {
    return null;
  }
}

function readAccessToken(dbPath: string): string | null {
  const sql = `SELECT value FROM ItemTable WHERE key = '${ACCESS_TOKEN_KEY}' LIMIT 1`;
  const rows = readSqliteWithSnapshot(dbPath, (snapshot) =>
    queryDbJson(snapshot, sql, { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }),
  );
  const value = rows[0]?.value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildSessionCookie(jwt: string): string | null {
  let userId = extractUserIdFromCliConfig(cursorCliConfigPath());
  if (!userId) userId = extractUserIdFromJwt(jwt);
  if (!userId) return null;
  return `${SESSION_COOKIE}=${userId}%3A%3A${jwt}`;
}

async function fetchUsageCsv(cookie: string): Promise<string> {
  const baseUrl = (process.env.CURSOR_WEB_BASE_URL?.trim() || 'https://cursor.com').replace(/\/+$/, '');
  const url = `${baseUrl}/api/dashboard/export-usage-events-csv?strategy=tokens`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Accept: 'text/csv,*/*;q=0.8',
        Cookie: cookie,
        Origin: baseUrl,
        Referer: `${baseUrl}/dashboard?tab=usage`,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
    throw new CursorSyncSkippedError(`Cursor 用量拉取跳过 (${reason})`);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new CursorNotLoggedInError();
  }
  if (!resp.ok) {
    if (resp.status === 429 || resp.status >= 500) {
      throw new CursorSyncSkippedError(`Cursor 用量拉取跳过 (HTTP ${resp.status})`);
    }
    throw new Error(`Cursor API 返回 ${resp.status}`);
  }
  return resp.text();
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function toNum(value: string | undefined): number {
  if (value == null) return 0;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toFloat(value: string | undefined): number {
  if (value == null) return 0;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface CursorCsvRecord {
  cacheComplete?: boolean;
  date: string;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export function parseCursorCsv(csvText: string): CursorCsvRecord[] {
  const lines = csvText.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headerFields = parseCsvLine(lines[0]!).map(stripQuotes);
  const columnIndex = new Map<string, number>();
  for (let i = 0; i < headerFields.length; i++) {
    columnIndex.set(headerFields[i]!, i);
  }

  const dateIdx = columnIndex.get('Date');
  const modelIdx = columnIndex.get('Model');
  const inputWithIdx = columnIndex.get('Input (w/ Cache Write)');
  const inputWithoutIdx = columnIndex.get('Input (w/o Cache Write)');
  const cacheReadIdx = columnIndex.get('Cache Read');
  const outputIdx = columnIndex.get('Output Tokens');
  const totalIdx = columnIndex.get('Total Tokens');
  const costIdx = columnIndex.get('Cost');

  const required = [dateIdx, modelIdx, inputWithIdx, inputWithoutIdx, cacheReadIdx, outputIdx, totalIdx];
  if (required.some((idx) => idx === undefined)) return [];

  const minFields = Math.max(...required.filter((x): x is number => x !== undefined)) + 1;
  const records: CursorCsvRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    if (fields.length < minFields) continue;

    const inputWithCache = toNum(fields[inputWithIdx!]);
    const inputWithoutCache = toNum(fields[inputWithoutIdx!]);
    const record: CursorCsvRecord = {
      cacheComplete:
        [inputWithIdx!, inputWithoutIdx!, cacheReadIdx!].every((idx) => {
          const value = fields[idx]?.replace(/,/g, '').trim();
          return !!value && validUsageFields([Number(value)]);
        }) && inputWithCache >= inputWithoutCache,
      date: stripQuotes(fields[dateIdx!]!),
      model: stripQuotes(fields[modelIdx!]!),
      inputTokens: inputWithoutCache,
      cacheWriteTokens: Math.max(0, inputWithCache - inputWithoutCache),
      cacheReadTokens: toNum(fields[cacheReadIdx!]),
      outputTokens: toNum(fields[outputIdx!]),
      totalTokens: toNum(fields[totalIdx!]),
      costUsd: costIdx !== undefined ? toFloat(fields[costIdx]) : 0,
    };

    if (record.totalTokens <= 0 && record.inputTokens <= 0 && record.outputTokens <= 0) continue;
    records.push(record);
  }

  return records;
}

function normalizeCursorRecord(record: CursorCsvRecord): TokenTotals | null {
  const input = Math.max(0, record.inputTokens);
  const cacheWrite = Math.max(0, record.cacheWriteTokens);
  const cacheRead = Math.max(0, record.cacheReadTokens);
  const output = Math.max(0, record.outputTokens);
  const totals = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    reasoning_output_tokens: 0,
  };
  const total = computeTotalTokens(totals);
  if (total === 0) return null;
  return {
    ...totals,
    total_tokens: total,
    conversation_count: 1,
    local_metrics: localEvidence(
      1,
      true,
      record.cacheComplete !== false,
      record.cacheComplete !== false,
    ),
  };
}

export function recordsToBuckets(
  records: CursorCsvRecord[],
  statsSince: string,
): QueueBucket[] {
  const sinceMs = new Date(statsSince).getTime();
  const bucketState: BucketAccumulator = new Map();
  const costByKey = new Map<string, number>();

  for (const record of records) {
    const delta = normalizeCursorRecord(record);
    if (!delta) continue;
    const hourStart = toUtcHalfHourStart(record.date);
    if (!hourStart || new Date(hourStart).getTime() < sinceMs) continue;

    const model = record.model || 'unknown';
    accumulateBucket(bucketState, 'cursor', model, 'unknown', hourStart, delta);

    if (record.costUsd > 0) {
      const key = bucketStateKey('cursor', model, 'unknown', hourStart);
      costByKey.set(key, (costByKey.get(key) ?? 0) + record.costUsd);
    }
  }

  return bucketsFromState(bucketState, 'cursor').map((bucket) => {
    const key = bucketStateKey(bucket.source, bucket.model, bucket.project, bucket.hour_start);
    const reported = costByKey.get(key);
    if (reported != null && reported > 0) {
      return { ...bucket, reported_cost_usd: reported };
    }
    return bucket;
  });
}

export interface ParseCursorResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export interface ParseCursorOptions {
  /**
   * Skip the remote CSV fetch when the last successful sync is newer than
   * this. Background poll uses it so cursor.com is not hit every minute;
   * manual / hook syncs pass nothing and always fetch.
   */
  minFetchIntervalMs?: number;
}

export async function parseCursorIncremental(
  cursors: CursorsFile,
  statsSince: string,
  options: ParseCursorOptions = {},
): Promise<{ result: ParseCursorResult; cursors: CursorsFile }> {
  if (!cursors.cursor) {
    cursors.cursor = {};
  }

  if (options.minFetchIntervalMs && cursors.cursor.lastSyncAt) {
    const elapsed = Date.now() - Date.parse(cursors.cursor.lastSyncAt);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < options.minFetchIntervalMs) {
      // Fresh enough; skip without touching state.vscdb or the network.
      // Intentionally leave lastError untouched — this is not a failure.
      return {
        result: {
          buckets: [],
          eventsParsed: 0,
          filesProcessed: 0,
          skipped: true,
          error: 'Cursor 用量拉取节流（距上次同步过近）',
        },
        cursors,
      };
    }
  }

  const dbPath = cursorStateVscdbPath();
  if (!existsSync(dbPath)) {
    cursors.cursor.lastError = 'Cursor 未安装或未登录';
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: cursors.cursor.lastError },
      cursors,
    };
  }

  let cookie: string | null = null;
  if (cookieCache && Date.now() - cookieCache.cachedAt < COOKIE_CACHE_TTL_MS) {
    cookie = cookieCache.cookie;
  } else {
    let jwt: string | null;
    try {
      jwt = readAccessToken(dbPath);
    } catch (err) {
      if (err instanceof Error && err.message.includes('ENOENT')) {
        cursors.cursor.lastError = '需要 sqlite3 CLI 或 Node >= 22.5 以读取 Cursor 数据库';
        return {
          result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: cursors.cursor.lastError },
          cursors,
        };
      }
      if (isSqliteLockError(err)) {
        cursors.cursor.lastError = 'Cursor 数据库被锁定，本轮跳过';
        return {
          result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: cursors.cursor.lastError },
          cursors,
        };
      }
      throw err;
    }

    if (!jwt) {
      cursors.cursor.lastError = 'Cursor 未登录';
      return {
        result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: cursors.cursor.lastError },
        cursors,
      };
    }

    cookie = buildSessionCookie(jwt);
    if (!cookie) {
      cursors.cursor.lastError = '无法解析 Cursor 会话凭证';
      return {
        result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: cursors.cursor.lastError },
        cursors,
      };
    }
    cookieCache = { cookie, cachedAt: Date.now() };
  }

  try {
    const csvText = await fetchUsageCsv(cookie);
    const records = parseCursorCsv(csvText);
    const buckets = recordsToBuckets(records, statsSince);

    let latestTs = cursors.cursor.lastRecordTimestamp ?? null;
    for (const record of records) {
      if (!latestTs || record.date > latestTs) latestTs = record.date;
    }

    cursors.cursor.lastRecordTimestamp = latestTs;
    cursors.cursor.lastSyncAt = new Date().toISOString();
    cursors.cursor.lastError = null;

    return {
      result: {
        buckets,
        eventsParsed: records.length,
        filesProcessed: 1,
      },
      cursors,
    };
  } catch (err) {
    if (err instanceof CursorNotLoggedInError) {
      // The cached cookie may be stale; force a fresh read next round.
      cookieCache = null;
    }
    if (err instanceof CursorNotLoggedInError || err instanceof CursorSyncSkippedError) {
      cursors.cursor.lastError = err.message;
      return {
        result: {
          buckets: [],
          eventsParsed: 0,
          filesProcessed: 0,
          skipped: true,
          error: err.message,
        },
        cursors,
      };
    }
    throw err;
  }
}

export async function readCursorCliConfig(): Promise<unknown> {
  const path = cursorCliConfigPath();
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

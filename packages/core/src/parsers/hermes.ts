/**
 * paths.ts exports needed:
 *   hermesHome(): string  — $HERMES_HOME || ~/.hermes
 *   hermesDbPaths(): Array<{ profile: string; dbPath: string; collector: string }>
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
} from './shared.js';
import { queryDbJson, readSqliteWithSnapshot } from './sqlite.js';

export const HERMES_COLLECTOR = 'hermes';

type HermesTotals = Omit<TokenTotals, 'conversation_count'>;

interface HermesSessionSnapshot extends HermesTotals {
  message_count: number;
}

interface HermesProfileCursor {
  snapshots: Record<string, HermesSessionSnapshot>;
  unfinishedIds: string[];
  lastCompletedStartedAt?: number;
}

interface HermesCursors {
  profiles: Record<string, HermesProfileCursor>;
}

function toNonNeg(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function hermesCollectorForProfile(profile: string): string {
  return profile === 'default' ? HERMES_COLLECTOR : `${HERMES_COLLECTOR}-${profile}`;
}

/** Hermes home directory ($HERMES_HOME or ~/.hermes). */
export function hermesHome(): string {
  const env = process.env.HERMES_HOME?.trim();
  if (env) {
    return env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
  }
  return join(homedir(), '.hermes');
}

/** Default + named profile SQLite DB paths. */
export function hermesDbPaths(home = hermesHome()): Array<{
  profile: string;
  dbPath: string;
  collector: string;
}> {
  const dbs: Array<{ profile: string; dbPath: string; collector: string }> = [];

  const defaultDb = join(home, 'state.db');
  if (existsSync(defaultDb)) {
    dbs.push({
      profile: 'default',
      dbPath: defaultDb,
      collector: hermesCollectorForProfile('default'),
    });
  }

  const profilesDir = join(home, 'profiles');
  if (!existsSync(profilesDir)) return dbs;

  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return dbs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDb = join(profilesDir, entry.name, 'state.db');
    try {
      if (statSync(profileDb).isFile()) {
        dbs.push({
          profile: entry.name,
          dbPath: profileDb,
          collector: hermesCollectorForProfile(entry.name),
        });
      }
    } catch {
      // skip unreadable profile db
    }
  }

  return dbs;
}

const SESSION_COLUMNS = `id,
    model,
    started_at,
    ended_at,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
    reasoning_tokens,
    message_count`;

/**
 * Newest message timestamp of a session — the only signal in the Hermes schema
 * that says *when* a session's usage happened. `started_at` only says when the
 * session was created, and Hermes keeps messaging sessions open forever
 * (`ended_at IS NULL`), so a long-lived session must not be dated by it.
 */
const LAST_ACTIVITY_COLUMN =
  '(SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = sessions.id) AS last_message_at';

function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readHermesSessions(
  dbPath: string,
  lastCompletedStartedAt: number,
  unfinishedIds: string[],
): Record<string, unknown>[] {
  const since =
    Number.isFinite(lastCompletedStartedAt) && lastCompletedStartedAt > 0
      ? lastCompletedStartedAt
      : 0;
  const forceIds = [...new Set(unfinishedIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const forceIncludeSql =
    forceIds.length > 0 ? ` OR id IN (${forceIds.map(sqliteStringLiteral).join(',')})` : '';

  const whereSql = `FROM sessions
    WHERE (started_at >= ${since} OR ended_at IS NULL${forceIncludeSql})
      AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0 OR reasoning_tokens > 0)
    ORDER BY started_at ASC`;

  return readSqliteWithSnapshot(dbPath, (snap) => {
    try {
      return queryDbJson(
        snap,
        `SELECT ${SESSION_COLUMNS}, ${LAST_ACTIVITY_COLUMN} ${whereSql}`,
      );
    } catch {
      // A schema without a `messages` table keeps the legacy timeline; the
      // caller then falls back to ended_at / started_at.
      return queryDbJson(snap, `SELECT ${SESSION_COLUMNS} ${whereSql}`);
    }
  });
}

function snapshotFromRow(row: Record<string, unknown>): HermesSessionSnapshot | null {
  const input = toNonNeg(row.input_tokens);
  const output = toNonNeg(row.output_tokens);
  const cacheRead = toNonNeg(row.cache_read_tokens);
  const cacheWrite = toNonNeg(row.cache_write_tokens);
  const reasoning = toNonNeg(row.reasoning_tokens);
  const messageCount = toNonNeg(row.message_count);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) {
    return null;
  }
  const delta = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    reasoning_output_tokens: reasoning,
  };
  return {
    ...delta,
    total_tokens: computeTotalTokens(delta),
    message_count: messageCount,
  };
}

function diffHermesSnapshot(
  current: HermesSessionSnapshot,
  previous: HermesSessionSnapshot | undefined,
): TokenTotals | null {
  if (!previous) {
    return { ...current, conversation_count: Math.max(1, current.message_count) };
  }

  const dInput = Math.max(0, current.input_tokens - previous.input_tokens);
  const dOutput = Math.max(0, current.output_tokens - previous.output_tokens);
  const dCacheRead = Math.max(0, current.cached_input_tokens - previous.cached_input_tokens);
  const dCacheWrite = Math.max(
    0,
    current.cache_creation_input_tokens - previous.cache_creation_input_tokens,
  );
  const dReasoning = Math.max(0, current.reasoning_output_tokens - previous.reasoning_output_tokens);
  const dMessageCount = Math.max(0, current.message_count - previous.message_count);

  if (dInput === 0 && dOutput === 0 && dCacheRead === 0 && dCacheWrite === 0 && dReasoning === 0) {
    return null;
  }

  const delta = {
    input_tokens: dInput,
    output_tokens: dOutput,
    cached_input_tokens: dCacheRead,
    cache_creation_input_tokens: dCacheWrite,
    reasoning_output_tokens: dReasoning,
  };
  return {
    ...delta,
    total_tokens: computeTotalTokens(delta),
    conversation_count: Math.max(1, dMessageCount),
  };
}

/**
 * Bucket time for a delta: the session's newest message wins, then its end
 * marker, then its start. Long-lived Hermes sessions stay open forever, so
 * dating their usage by `started_at` pushes every later day's usage back onto
 * the day the session was created.
 */
function sessionActivitySec(
  row: Record<string, unknown>,
  startedAt: number,
  endedAt: number | null,
): number | null {
  const lastMessageAt =
    row.last_message_at == null ? null : Number(row.last_message_at);
  for (const candidate of [lastMessageAt, endedAt, startedAt]) {
    if (candidate != null && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

function ingestHermesProfile(
  dbPath: string,
  profileState: HermesProfileCursor,
  profile: string,
  collector: string,
  sinceMs: number,
  bucketState: BucketAccumulator,
): { eventsParsed: number; recordsProcessed: number } {
  const prevSnapshots = profileState.snapshots ?? {};
  const unfinishedIds = profileState.unfinishedIds ?? [];
  const lastCompletedStartedAt = profileState.lastCompletedStartedAt ?? 0;

  let rows: Record<string, unknown>[];
  try {
    rows = readHermesSessions(dbPath, lastCompletedStartedAt, unfinishedIds);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|sqlite3 CLI not found/i.test(msg)) {
      throw new Error(
        'sqlite3 CLI not found. Install sqlite3 (or use Node >= 22.5) to sync Hermes data.',
      );
    }
    throw err;
  }

  let eventsParsed = 0;
  let maxCompletedStartedAt = lastCompletedStartedAt;
  let oldestUnfinishedStartedAt = Infinity;
  const nextUnfinishedIds = new Set<string>();
  const nextSnapshots: Record<string, HermesSessionSnapshot> = {};

  for (const row of rows) {
    const sessionId = typeof row.id === 'string' ? row.id : null;
    const current = snapshotFromRow(row);
    if (!current || !sessionId) continue;

    nextSnapshots[sessionId] = current;

    const startedAt = Number(row.started_at);
    const endedAt = row.ended_at == null ? null : Number(row.ended_at);

    if (endedAt == null) {
      if (Number.isFinite(startedAt)) {
        nextUnfinishedIds.add(sessionId);
        oldestUnfinishedStartedAt = Math.min(oldestUnfinishedStartedAt, startedAt);
      }
    } else if (Number.isFinite(startedAt) && startedAt > maxCompletedStartedAt) {
      maxCompletedStartedAt = startedAt;
    }

    const delta = diffHermesSnapshot(current, prevSnapshots[sessionId]);
    if (!delta) continue;

    const epochSec = sessionActivitySec(row, startedAt, endedAt);
    if (epochSec == null) continue;

    const tsIso = new Date(epochSec * 1000).toISOString();
    const hourStart = toUtcHalfHourStart(tsIso);
    if (!hourStart) continue;
    if (new Date(hourStart).getTime() < sinceMs) continue;

    const model = typeof row.model === 'string' && row.model ? row.model : 'hermes-agent';
    accumulateBucket(
      bucketState,
      'hermes',
      model,
      profile,
      hourStart,
      delta,
      collector,
    );
    eventsParsed += 1;
  }

  const nextLastCompletedStartedAt = Number.isFinite(oldestUnfinishedStartedAt)
    ? Math.min(maxCompletedStartedAt, oldestUnfinishedStartedAt)
    : maxCompletedStartedAt;

  profileState.snapshots = nextSnapshots;
  profileState.unfinishedIds = Array.from(nextUnfinishedIds);
  profileState.lastCompletedStartedAt = nextLastCompletedStartedAt;

  return { eventsParsed, recordsProcessed: rows.length };
}

export interface ParseHermesResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseHermesIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseHermesResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const hermesRoot = (cursors as CursorsFile & { hermes?: HermesCursors }).hermes;
  if (!hermesRoot) {
    (cursors as CursorsFile & { hermes: HermesCursors }).hermes = { profiles: {} };
  }
  const profiles = (cursors as CursorsFile & { hermes: HermesCursors }).hermes.profiles;
  const bucketState: BucketAccumulator = new Map();

  const dbEntries = hermesDbPaths();
  if (dbEntries.length === 0) {
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0 },
      cursors,
    };
  }

  let eventsParsed = 0;
  let filesProcessed = 0;
  let sqliteMissing = false;
  let sqliteError = '';

  for (const entry of dbEntries) {
    if (!profiles[entry.profile]) {
      profiles[entry.profile] = { snapshots: {}, unfinishedIds: [] };
    }
    const profileState = profiles[entry.profile]!;

    try {
      const parsed = ingestHermesProfile(
        entry.dbPath,
        profileState,
        entry.profile,
        entry.collector,
        sinceMs,
        bucketState,
      );
      eventsParsed += parsed.eventsParsed;
      filesProcessed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/sqlite3 CLI not found/i.test(msg)) {
        sqliteMissing = true;
        sqliteError = msg;
        break;
      }
      // Unreadable DB for this profile — skip.
    }
  }

  if (sqliteMissing) {
    return {
      result: {
        buckets: [],
        eventsParsed: 0,
        filesProcessed: 0,
        skipped: true,
        error: sqliteError,
      },
      cursors,
    };
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'hermes'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

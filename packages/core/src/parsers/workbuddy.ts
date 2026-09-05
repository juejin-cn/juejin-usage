/**
 * WorkBuddy passive reader (source `workbuddy`, collector `workbuddy`).
 *
 * Recursively scans ~/.workbuddy/projects/ for .jsonl files (including subagents/).
 * Token math differs from CodeBuddy — see normalizeWorkbuddyUsage().
 * SQLite fallback reads workbuddy.db session_usage when a session has no JSONL detail.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
} from './shared.js';
import { queryDbJson, readSqliteWithSnapshot, sqliteTableExists } from './sqlite.js';

export const WORKBUDDY_COLLECTOR = 'workbuddy';

type WorkbuddyExtCursors = CursorsFile & {
  workbuddy?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
    sqliteSessions?: Record<
      string,
      { used: number; updatedAt?: number; model?: string }
    >;
    detailedSessions?: Record<string, boolean>;
  };
};

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function resolveWorkbuddyHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WORKBUDDY_HOME?.trim();
  if (override) return expandHome(override);
  return join(homedir(), '.workbuddy');
}

export function resolveWorkbuddyDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  const fallback = 'auto';
  try {
    const home = resolveWorkbuddyHome(env);
    const raw = readFileSync(join(home, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { model?: unknown };
    if (typeof parsed.model === 'string' && parsed.model.trim()) return parsed.model.trim();
  } catch {
    // settings missing or malformed
  }
  return fallback;
}

function walkJsonlFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walkJsonlFiles(full, out);
    else if (isFile && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

export function resolveWorkbuddyProjectFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = resolveWorkbuddyHome(env);
  const files: string[] = [];
  const projectsDir = join(home, 'projects');
  if (existsSync(projectsDir)) walkJsonlFiles(projectsDir, files);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toNonNeg(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

/** WorkBuddy-specific token split (NOT the same as CodeBuddy). */
function normalizeWorkbuddyUsage(
  rawUsage: Record<string, unknown>,
): Omit<TokenTotals, 'conversation_count'> | null {
  const promptTokens = toNonNeg(rawUsage.prompt_tokens);
  const completionTokens = toNonNeg(rawUsage.completion_tokens);
  const promptDetails =
    rawUsage.prompt_tokens_details && typeof rawUsage.prompt_tokens_details === 'object'
      ? (rawUsage.prompt_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    rawUsage.completion_tokens_details && typeof rawUsage.completion_tokens_details === 'object'
      ? (rawUsage.completion_tokens_details as Record<string, unknown>)
      : {};

  const cacheRead = Math.max(
    toNonNeg(rawUsage.cache_read_input_tokens),
    toNonNeg(promptDetails.cached_tokens),
    toNonNeg(rawUsage.prompt_cache_hit_tokens),
  );
  const cacheCreation = toNonNeg(rawUsage.cache_creation_input_tokens);
  const inputTokens = Math.max(0, promptTokens - cacheRead - cacheCreation);
  const reasoningTokens = Math.min(
    completionTokens,
    toNonNeg(completionDetails.reasoning_tokens),
  );
  const outputTokens = Math.max(0, completionTokens - reasoningTokens);

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheRead === 0 &&
    cacheCreation === 0 &&
    reasoningTokens === 0
  ) {
    return null;
  }

  const body = {
    input_tokens: inputTokens,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningTokens,
  };
  return { ...body, total_tokens: computeTotalTokens(body) };
}

export interface ParseWorkbuddyResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

/** Empty / non-string cwd (e.g. LEFT JOIN miss) stays 'unknown'. */
function projectFromCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || !cwd.trim()) return 'unknown';
  return resolveProjectName(cwd.trim());
}

/**
 * `sessions.id → cwd` from workbuddy.db; JSONL messages only carry a
 * sessionId, the working directory lives in this table.
 */
function loadWorkbuddySessionCwds(dbPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!sqliteTableExists(dbPath, 'sessions')) return map;
  try {
    const rows = readSqliteWithSnapshot(dbPath, (snap) =>
      queryDbJson(snap, 'SELECT id, cwd FROM sessions WHERE cwd IS NOT NULL', {
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      const cwd = typeof row.cwd === 'string' ? row.cwd.trim() : '';
      if (id && cwd) map.set(id, cwd);
    }
  } catch {
    // Best effort; unresolved sessions stay 'unknown'.
  }
  return map;
}

export async function parseWorkbuddyIncremental(
  cursors: CursorsFile,
  statsSince: string,
  opts?: { env?: NodeJS.ProcessEnv; projectFiles?: string[]; defaultModel?: string },
): Promise<{ result: ParseWorkbuddyResult; cursors: CursorsFile }> {
  const env = opts?.env ?? process.env;
  const sinceMs = new Date(statsSince).getTime();
  const ext = cursors as WorkbuddyExtCursors;
  if (!ext.workbuddy) {
    ext.workbuddy = { seenIds: [], fileOffsets: {}, sqliteSessions: {}, detailedSessions: {} };
  }
  if (!ext.workbuddy.fileOffsets) ext.workbuddy.fileOffsets = {};
  if (!ext.workbuddy.sqliteSessions) ext.workbuddy.sqliteSessions = {};
  if (!ext.workbuddy.detailedSessions) ext.workbuddy.detailedSessions = {};

  const seenIds = new Set(ext.workbuddy.seenIds ?? []);
  const fileOffsets = ext.workbuddy.fileOffsets;
  const sqliteSessions = ext.workbuddy.sqliteSessions;
  const detailedSessions = ext.workbuddy.detailedSessions;
  const detailedSessionsWithUsage = new Set<string>();
  const bucketState: BucketAccumulator = new Map();
  const fallbackModel = opts?.defaultModel ?? resolveWorkbuddyDefaultModel(env);
  const files = opts?.projectFiles ?? resolveWorkbuddyProjectFiles(env);
  const workbuddyHome = resolveWorkbuddyHome(env);
  const dbPath = join(workbuddyHome, 'workbuddy.db');
  const dbExists = existsSync(dbPath);

  // Loaded on first use so idle rounds skip the extra sqlite read.
  let sessionCwds: Map<string, string> | null = null;
  const getSessionCwd = (sessionId: string): string | undefined => {
    if (!dbExists) return undefined;
    if (!sessionCwds) sessionCwds = loadWorkbuddySessionCwds(dbPath);
    return sessionCwds.get(sessionId);
  };

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileOffsets[filePath];
    const prevSize = prev?.size ?? 0;
    const inodeChanged = typeof prev?.ino === 'number' && prev.ino !== st.ino;
    const startOffset = st.size < prevSize || inodeChanged ? 0 : prevSize;
    if (st.size <= startOffset) continue;

    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const provider =
        entry.providerData && typeof entry.providerData === 'object'
          ? (entry.providerData as Record<string, unknown>)
          : null;
      const rawUsage =
        provider?.rawUsage && typeof provider.rawUsage === 'object'
          ? (provider.rawUsage as Record<string, unknown>)
          : null;
      if (!provider || !rawUsage) continue;

      const sessionId =
        typeof entry.sessionId === 'string' && entry.sessionId
          ? entry.sessionId
          : basename(filePath, '.jsonl');
      if (Object.prototype.hasOwnProperty.call(sqliteSessions, sessionId)) continue;

      const tsMs =
        Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) > 0
          ? Number(entry.timestamp)
          : null;
      const messageId =
        typeof entry.id === 'string' && entry.id
          ? entry.id
          : typeof provider.messageId === 'string' && provider.messageId
            ? provider.messageId
            : tsMs != null
              ? `${sessionId}:${tsMs}`
              : null;
      if (!messageId || seenIds.has(messageId)) continue;

      const delta = normalizeWorkbuddyUsage(rawUsage);
      if (!delta) {
        seenIds.add(messageId);
        continue;
      }
      if (tsMs == null) {
        seenIds.add(messageId);
        continue;
      }

      const hourStart = toUtcHalfHourStart(new Date(tsMs).toISOString());
      if (!hourStart || new Date(hourStart).getTime() < sinceMs) {
        seenIds.add(messageId);
        continue;
      }

      const model =
        normalizeModel(provider.model) ??
        normalizeModel(provider.requestModelId) ??
        normalizeModel(entry.model) ??
        fallbackModel;

      accumulateBucket(
        bucketState,
        'workbuddy',
        model,
        projectFromCwd(getSessionCwd(sessionId)),
        hourStart,
        { ...delta, conversation_count: 1 },
        WORKBUDDY_COLLECTOR,
      );
      seenIds.add(messageId);
      detailedSessions[sessionId] = true;
      detailedSessionsWithUsage.add(sessionId);
      eventsParsed += 1;
    }

    const postStat = await stat(filePath).catch(() => st);
    fileOffsets[filePath] = {
      size: postStat.size,
      mtimeMs: postStat.mtimeMs,
      ino: postStat.ino,
    };
    filesProcessed += 1;
  }

  // Older WorkBuddy DBs only have sessions/workspaces — skip when session_usage is absent.
  if (dbExists && sqliteTableExists(dbPath, 'session_usage')) {
    const query = `
      SELECT
        su.session_id,
        su.used,
        su.updated_at,
        s.model,
        s.cwd
      FROM session_usage su
      LEFT JOIN sessions s ON s.id = su.session_id
      WHERE su.used IS NOT NULL
        AND su.used > 0
        AND su.updated_at IS NOT NULL
        AND su.updated_at > 0
    `.trim();

    try {
      const rows = readSqliteWithSnapshot(dbPath, (snap) =>
        queryDbJson(snap, query, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }),
      );

      for (const row of rows) {
        const sessionId = typeof row.session_id === 'string' ? row.session_id.trim() : '';
        if (!sessionId) continue;
        if (detailedSessions[sessionId] || detailedSessionsWithUsage.has(sessionId)) continue;

        const usedNow = toNonNeg(row.used);
        const updatedAtRaw = toNonNeg(row.updated_at);
        const rawModel = typeof row.model === 'string' ? row.model.trim() : '';
        if (usedNow <= 0 || updatedAtRaw <= 0) continue;

        const prev = sqliteSessions[sessionId] ?? { used: 0 };
        const prevUsed = toNonNeg(prev.used);
        const isReset = usedNow > 0 && prevUsed > 0 && usedNow < prevUsed;
        const inputDelta = isReset ? usedNow : Math.max(0, usedNow - prevUsed);
        if (inputDelta === 0) {
          sqliteSessions[sessionId] = {
            ...prev,
            used: usedNow,
            updatedAt: updatedAtRaw,
            model: rawModel || prev.model || fallbackModel,
          };
          continue;
        }

        const tsMs = updatedAtRaw > 10_000_000_000 ? updatedAtRaw : updatedAtRaw * 1000;
        const hourStart = toUtcHalfHourStart(new Date(tsMs).toISOString());
        if (!hourStart || new Date(hourStart).getTime() < sinceMs) {
          sqliteSessions[sessionId] = {
            used: usedNow,
            updatedAt: updatedAtRaw,
            model: normalizeModel(rawModel) || fallbackModel,
          };
          continue;
        }

        const model = normalizeModel(rawModel) || fallbackModel;
        const delta: TokenTotals = {
          input_tokens: inputDelta,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: inputDelta,
          conversation_count: prevUsed === 0 || isReset ? 1 : 0,
        };

        accumulateBucket(
          bucketState,
          'workbuddy',
          model,
          projectFromCwd(row.cwd),
          hourStart,
          delta,
          WORKBUDDY_COLLECTOR,
        );
        sqliteSessions[sessionId] = {
          used: usedNow,
          updatedAt: updatedAtRaw,
          model,
        };
        eventsParsed += 1;
      }
    } catch {
      // SQLite fallback is best effort; detailed JSONL remains authoritative.
    }
  }

  ext.workbuddy.seenIds = Array.from(seenIds).slice(-10_000);
  const sqliteEntries = Object.entries(sqliteSessions);
  if (sqliteEntries.length > 10_000) {
    ext.workbuddy.sqliteSessions = Object.fromEntries(
      sqliteEntries
        .sort((a, b) => toNonNeg(b[1]?.used) - toNonNeg(a[1]?.used))
        .slice(0, 10_000),
    );
  }
  const detailedEntries = Object.entries(detailedSessions);
  if (detailedEntries.length > 10_000) {
    ext.workbuddy.detailedSessions = Object.fromEntries(
      detailedEntries.slice(detailedEntries.length - 10_000),
    );
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'workbuddy'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

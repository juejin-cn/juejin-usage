import { existsSync } from 'node:fs';
import { localEvidence } from '../local-metrics.js';
import type { CursorsFile, QueueBucket } from '../types.js';
import { devecoDbPath } from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import { accumulateBucket, bucketsFromState, type BucketAccumulator } from './shared.js';
import { deriveOpencodeMessageKey, normalizeOpencodeTokens, opencodeModelName } from './opencode.js';
import { queryDbJson } from './sqlite.js';
import { diffGeminiTotals, sameGeminiTotals } from './gemini.js';

export const DEVECO_COLLECTOR = 'deveco-code';

function numberMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(value);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

function projectFromRow(row: Record<string, unknown>): string {
  for (const value of [row.rootPath, row.cwdPath, row.sessionDirectory, row.sessionPath]) {
    if (typeof value === 'string' && value.trim()) {
      const project = resolveProjectName(value);
      if (project !== 'unknown') return project;
    }
  }
  return 'unknown';
}

/** Session totals repeat message totals; consume only the per-call records. */
function usageQuery(dbPath: string): string {
  const tables = new Set(
    queryDbJson(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name),
  );
  const hasSession = tables.has('session');
  const select = (alias: string) => `SELECT
    ${alias}.id as id,
    ${alias}.session_id as sessionID,
    json_extract(${alias}.data, '$.time.created') as created,
    json_extract(${alias}.data, '$.time.completed') as completed,
    json_extract(${alias}.data, '$.modelID') as modelID,
    json_extract(${alias}.data, '$.model') as model,
    json_extract(${alias}.data, '$.modelId') as modelId,
    json_extract(${alias}.data, '$.tokens') as tokens,
    json_extract(${alias}.data, '$.path.root') as rootPath,
    json_extract(${alias}.data, '$.path.cwd') as cwdPath,
    ${hasSession
      ? 's.directory as sessionDirectory, s.path as sessionPath'
      : 'NULL as sessionDirectory, NULL as sessionPath'}`;
  const join = (alias: string) => hasSession
    ? `LEFT JOIN session s ON s.id = ${alias}.session_id`
    : '';
  const queries: string[] = [];
  if (tables.has('session_message')) {
    queries.push(`${select('sm')}
      FROM session_message sm
      ${join('sm')}
      WHERE sm.type IN ('assistant', 'compaction')`);
  }
  if (tables.has('message')) {
    // A pending projection or a non-call event must not hide a legacy usage row.
    const exclude = tables.has('session_message')
      ? `AND NOT EXISTS (
          SELECT 1 FROM session_message sm
          WHERE sm.id = m.id
            AND sm.type IN ('assistant', 'compaction')
            AND json_extract(sm.data, '$.tokens') IS NOT NULL)
        `
      : '';
    queries.push(`${select('m')}
      FROM message m
      ${join('m')}
      WHERE json_extract(m.data, '$.role') = 'assistant'
      ${exclude}`);
  }
  if (!queries.length) throw new Error('DevEco database has no supported message tables');
  return queries.join(' UNION ALL ');
}

export interface ParseDevecoResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseDevecoIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseDevecoResult; cursors: CursorsFile }> {
  const cursor = cursors.deveco ??= { messages: {} };
  if (!Number.isFinite(new Date(statsSince).getTime())) {
    throw new Error('Invalid DevEco collection start date');
  }
  const sinceMs = new Date(statsSince).getTime();
  const state: BucketAccumulator = new Map();
  let rows: Record<string, unknown>[];
  const dbPath = devecoDbPath();
  if (!existsSync(dbPath)) {
    return { result: { buckets: [], eventsParsed: 0, filesProcessed: 0 }, cursors };
  }
  try {
    rows = queryDbJson(dbPath, usageQuery(dbPath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: message }, cursors };
  }
  let eventsParsed = 0;
  for (const row of rows) {
    let tokens: Record<string, unknown> | null = null;
    try {
      tokens = typeof row.tokens === 'string'
        ? JSON.parse(row.tokens) as Record<string, unknown>
        : row.tokens as Record<string, unknown> | null;
    } catch {
      continue;
    }
    const totals = normalizeOpencodeTokens(tokens);
    if (!totals) continue;
    const sessionId = typeof row.sessionID === 'string' ? row.sessionID : null;
    const msgId = typeof row.id === 'string' ? row.id : null;
    const key = deriveOpencodeMessageKey(sessionId, msgId);
    if (!key) continue;
    const previous = cursor.messages[key]?.lastTotals;
    if (sameGeminiTotals(totals, previous)) continue;
    const delta = diffGeminiTotals(totals, previous);
    if (!delta) continue;
    cursor.messages[key] = { lastTotals: totals };
    const timestamp = numberMs(row.completed) ?? numberMs(row.created);
    if (timestamp == null) continue;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) continue;
    const hour = toUtcHalfHourStart(date.toISOString());
    if (!hour || new Date(hour).getTime() < sinceMs) continue;
    accumulateBucket(
      state, 'deveco', opencodeModelName(row), projectFromRow(row), hour,
      {
        ...delta,
        conversation_count: 1,
        local_metrics: localEvidence(
          previous ? 0 : 1, true,
          totals.local_metrics?.cacheReadComplete ?? false,
          totals.local_metrics?.cacheWriteComplete ?? false,
        ),
      },
      DEVECO_COLLECTOR,
    );
    eventsParsed += 1;
  }
  return {
    result: {
      buckets: bucketsFromState(state, 'deveco'),
      eventsParsed,
      filesProcessed: rows.length ? 1 : 0,
    },
    cursors,
  };
}

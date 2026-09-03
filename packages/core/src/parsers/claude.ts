import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import {
  claudeCliProjectsDirs,
  claudeDesktopProjectsDirs,
  claudeProjectsDirs,
} from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  findJsonlFiles,
  type BucketAccumulator,
} from './shared.js';

export const CLAUDE_COLLECTOR_CLI = 'claude-code-cli';
export const CLAUDE_COLLECTOR_DESKTOP = 'claude-desktop';

/** Max lines to scan from file start for cwd (incremental sync may start mid-file). */
const CWD_PEEK_MAX_LINES = 80;

interface ClaudeCacheCreation {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: ClaudeCacheCreation;
}

interface ClaudeMessage {
  type?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  cwd?: string;
  message?: { id?: string; model?: string; usage?: ClaudeUsage };
}

const MAX_SEEN_USAGE = 50_000;

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Prefer the scalar total; fall back to 5m+1h TTL split when the scalar is missing. */
export function claudeCacheCreationTokens(usage: ClaudeUsage): number {
  const direct = toCount(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation;
  const split = breakdown
    ? toCount(breakdown.ephemeral_5m_input_tokens) + toCount(breakdown.ephemeral_1h_input_tokens)
    : 0;
  return Math.max(direct, split);
}

export function claudeMessageDedupKey(obj: ClaudeMessage): string | null {
  const msgId = obj?.message?.id;
  if (!msgId) return null;
  const reqId = obj?.requestId;
  return reqId ? `${msgId}:${reqId}` : msgId;
}

export function normalizeClaudeUsage(u: ClaudeUsage): TokenTotals {
  const input = toCount(u.input_tokens);
  const output = toCount(u.output_tokens);
  const cacheCreation = claudeCacheCreationTokens(u);
  const cacheRead = toCount(u.cache_read_input_tokens);
  const body = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    reasoning_output_tokens: 0,
  };
  return {
    ...body,
    total_tokens: computeTotalTokens(body),
    conversation_count: 1,
  };
}

function capSeenUsage(seenUsage: Record<string, TokenTotals>): Record<string, TokenTotals> {
  const keys = Object.keys(seenUsage);
  if (keys.length <= MAX_SEEN_USAGE) return seenUsage;
  const drop = keys.length - MAX_SEEN_USAGE;
  const next: Record<string, TokenTotals> = {};
  for (const key of keys.slice(drop)) {
    next[key] = seenUsage[key]!;
  }
  return next;
}

function diffClaudeUsage(next: TokenTotals, prev: TokenTotals | undefined): TokenTotals | null {
  if (!prev) {
    return next.total_tokens > 0 ? { ...next, conversation_count: 1 } : null;
  }
  const body = {
    input_tokens: Math.max(0, next.input_tokens - prev.input_tokens),
    output_tokens: Math.max(0, next.output_tokens - prev.output_tokens),
    cached_input_tokens: Math.max(0, next.cached_input_tokens - prev.cached_input_tokens),
    cache_creation_input_tokens: Math.max(
      0,
      next.cache_creation_input_tokens - prev.cache_creation_input_tokens,
    ),
    reasoning_output_tokens: Math.max(
      0,
      next.reasoning_output_tokens - prev.reasoning_output_tokens,
    ),
  };
  const total = computeTotalTokens(body);
  if (total === 0) return null;
  return { ...body, total_tokens: total, conversation_count: 0 };
}

function projectRelativePath(filePath: string, projectsDir: string): string | null {
  const prefix = projectsDir + sep;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

function extractProject(relative: string | null): string {
  if (!relative) return 'unknown';
  const firstSeg = relative.split(sep)[0];
  if (!firstSeg) return 'unknown';
  const parts = firstSeg.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : 'unknown';
}

/**
 * Read cwd from the start of a Claude session JSONL (lossy folder encoding is
 * unreliable when path segments contain hyphens). Used even when incremental
 * usage parse starts at a non-zero offset.
 */
export async function peekClaudeCwd(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  try {
    for await (const line of rl) {
      lines += 1;
      if (lines > CWD_PEEK_MAX_LINES) break;
      if (!line.includes('"cwd"')) continue;
      let obj: ClaudeMessage;
      try {
        obj = JSON.parse(line) as ClaudeMessage;
      } catch {
        continue;
      }
      const cwd = typeof obj.cwd === 'string' ? obj.cwd.trim() : '';
      if (cwd) return cwd;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

/** Prefer git toplevel from session cwd; fall back to encoded-path heuristic. */
export async function resolveClaudeProject(
  filePath: string,
  relative: string | null,
): Promise<string> {
  const cwd = await peekClaudeCwd(filePath);
  if (cwd) return resolveProjectName(cwd);
  return extractProject(relative);
}

interface PendingClaudeRow {
  model: string;
  project: string;
  collector: string;
  hourStart: string;
  totals: TokenTotals;
}

function underAnyRoot(filePath: string, roots: string[]): string | null {
  for (const root of roots) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (filePath === root || filePath.startsWith(prefix)) return root;
  }
  return null;
}

/** Resolve collector from absolute JSONL path (CLI vs Desktop sandbox). */
export function claudeCollectorForFile(filePath: string): string {
  if (underAnyRoot(filePath, claudeDesktopProjectsDirs())) {
    return CLAUDE_COLLECTOR_DESKTOP;
  }
  if (underAnyRoot(filePath, claudeCliProjectsDirs())) {
    return CLAUDE_COLLECTOR_CLI;
  }
  // Fallback: treat as CLI if under any merged projects dir.
  return CLAUDE_COLLECTOR_CLI;
}

export async function listClaudeProjectFiles(): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const projectsDir of claudeProjectsDirs()) {
    for (const f of await findJsonlFiles(projectsDir)) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }
  return files.sort();
}

export interface ParseClaudeResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
}

export async function parseClaudeIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseClaudeResult; cursors: CursorsFile }> {
  const files = await listClaudeProjectFiles();
  const sinceMs = new Date(statsSince).getTime();
  const allProjectsDirs = claudeProjectsDirs();

  if (!cursors.claude) {
    cursors.claude = { files: {}, seenHashes: [], seenUsage: {} };
  }
  const claudeCursor = cursors.claude;
  if (!claudeCursor.seenUsage) claudeCursor.seenUsage = {};
  const seenUsage = claudeCursor.seenUsage;
  const legacyHashes = new Set(claudeCursor.seenHashes ?? []);
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  const commitRow = (row: PendingClaudeRow, dedup: string | null): void => {
    if (dedup) {
      const prev = seenUsage[dedup];
      if (!prev && legacyHashes.has(dedup)) {
        // Already ingested under first-wins; seed last-wins from this snapshot.
        seenUsage[dedup] = row.totals;
        return;
      }
      const delta = diffClaudeUsage(row.totals, prev);
      seenUsage[dedup] = row.totals;
      if (!delta) return;
      accumulateBucket(
        bucketState,
        'claude',
        row.model,
        row.project,
        row.hourStart,
        delta,
        row.collector,
      );
      eventsParsed += 1;
      return;
    }
    accumulateBucket(
      bucketState,
      'claude',
      row.model,
      row.project,
      row.hourStart,
      row.totals,
      row.collector,
    );
    eventsParsed += 1;
  };

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = claudeCursor.files[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;

    // Skip before resolving project: the cwd peek opens the file, which would
    // otherwise re-read every session file on every poll round.
    if (sameInode && !truncated && startOffset >= st.size) {
      continue;
    }

    const projectsDir = allProjectsDirs.find((d) => filePath.startsWith(d + sep));
    const relative = projectsDir ? projectRelativePath(filePath, projectsDir) : null;
    const project =
      sameInode && prev.project
        ? prev.project
        : await resolveClaudeProject(filePath, relative);
    const collector = claudeCollectorForFile(filePath);

    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const keyedRows = new Map<string, PendingClaudeRow>();
    const unkeyedRows: PendingClaudeRow[] = [];

    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let obj: ClaudeMessage;
      try {
        obj = JSON.parse(line) as ClaudeMessage;
      } catch {
        continue;
      }
      if (obj.type !== 'assistant') continue;
      const usage = obj.message?.usage;
      if (!usage) continue;

      const ts = obj.timestamp;
      if (!ts) continue;
      const hourStart = toUtcHalfHourStart(ts);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const totals = normalizeClaudeUsage(usage);
      if (totals.total_tokens === 0) continue;

      const pending: PendingClaudeRow = {
        model: obj.message?.model ?? 'unknown',
        hourStart,
        totals,
        project,
        collector,
      };
      const dedup = claudeMessageDedupKey(obj);
      if (dedup) {
        keyedRows.set(dedup, pending);
      } else {
        unkeyedRows.push(pending);
      }
    }

    for (const [dedup, row] of keyedRows) {
      commitRow(row, dedup);
    }
    for (const row of unkeyedRows) {
      commitRow(row, null);
    }

    claudeCursor.files[filePath] = { inode, offset: st.size, project };
    filesProcessed += 1;
  }

  claudeCursor.seenUsage = capSeenUsage(seenUsage);
  const remainingLegacy = Array.from(legacyHashes).filter((k) => !claudeCursor.seenUsage![k]);
  claudeCursor.seenHashes = [...remainingLegacy, ...Object.keys(claudeCursor.seenUsage)].slice(
    -MAX_SEEN_USAGE,
  );

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'claude'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

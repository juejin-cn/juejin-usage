/**
 * WPS Comate passive reader (source `wps-comate`, collector `wps-comate`).
 *
 * Reads ~/.wpscomate/agent/task-sessions/*.jsonl — one file per agent task
 * session. The session header line (`type: "session"`) carries the cwd used
 * for project attribution; assistant messages embed a usage snapshot
 * (`input` / `output` / `cacheRead` / `cacheWrite` / `reasoning`) plus a
 * `responseModel` short name (e.g. `glm-5.3`) and a fully qualified `model`
 * id (`670468124/zhipu/glm-5.3//public`). The short name is preferred so the
 * pricing matcher's prefix-strip path resolves vendor pricing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { createJsonlLineReader } from './jsonl-tail.js';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
} from './shared.js';

export const WPS_COMATE_COLLECTOR = 'wps-comate';

interface WpsComateFileCursor {
  inode: number;
  offset: number;
  /** Resolved project name cached so unchanged files skip the cwd scan. */
  project?: string;
}

interface WpsComateCursors {
  files: Record<string, WpsComateFileCursor>;
  /** Assistant entry ids already counted (`<fileName>:<entryId>`). */
  seenIds: string[];
}

/** Max lines to scan from file start for the session cwd (incremental sync may start mid-file). */
const CWD_PEEK_MAX_LINES = 40;

function toNonNeg(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** WPS Comate agent home; override with `WPS_COMATE_HOME` (tests / portable installs). */
export function resolveWpsComateHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WPS_COMATE_HOME?.trim();
  if (override) return expandHome(override);
  return join(homedir(), '.wpscomate');
}

export function wpsComateSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveWpsComateHome(env), 'agent', 'task-sessions');
}

/** Flat `*.jsonl` listing under the sessions dir (no nesting observed). */
export function findWpsComateSessionFiles(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dir = wpsComateSessionsDir(env);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Short model name for pricing / display.
 *
 * `responseModel` (`glm-5.3`) is preferred over the qualified `model`
 * (`670468124/zhipu/glm-5.3//public`): the pricing matcher's prefix-strip
 * path resolves `glm-5.3` against `zai/glm-5.3` / `zhipuai/glm-5.3`, while
 * the qualified form would fall through to a fuzzy guess. Falls back to the
 * third `/`-separated segment of the qualified id, then to the raw value.
 */
export function wpsComateModelName(
  responseModel: unknown,
  qualifiedModel: unknown,
): string {
  if (typeof responseModel === 'string' && responseModel.trim()) {
    return responseModel.trim();
  }
  if (typeof qualifiedModel === 'string' && qualifiedModel.trim()) {
    const segments = qualifiedModel.split('/').filter(Boolean);
    // `670468124/zhipu/glm-5.3//public` → tenant / vendor / model / … / channel
    const candidate = segments[2];
    if (candidate) return candidate;
    return qualifiedModel.trim();
  }
  return 'wps-comate-unknown';
}

function normalizeWpsComateUsage(
  usage: Record<string, unknown>,
): Omit<TokenTotals, 'conversation_count'> | null {
  const input = toNonNeg(usage.input);
  const output = toNonNeg(usage.output);
  const cacheRead = toNonNeg(usage.cacheRead);
  const cacheWrite = toNonNeg(usage.cacheWrite);
  const reasoning = toNonNeg(usage.reasoning);
  const body = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    reasoning_output_tokens: reasoning,
  };
  const total = computeTotalTokens(body);
  if (total === 0) return null;
  return { ...body, total_tokens: total };
}

function coerceTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Read the cwd from the start of a session file. The session header is the
 * first line, but incremental scans may resume mid-file, so a bounded peek
 * from the top is the reliable way to attribute project names.
 */
export async function peekWpsComateCwd(
  filePath: string,
): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const reader = createJsonlLineReader(filePath, 0);
  let lines = 0;
  try {
    for await (const line of reader) {
      lines += 1;
      if (lines > CWD_PEEK_MAX_LINES) break;
      if (!line.includes('"type":"session"') && !line.includes('"cwd"')) continue;
      let obj: { type?: string; cwd?: unknown };
      try {
        obj = JSON.parse(line) as { type?: string; cwd?: unknown };
      } catch {
        continue;
      }
      if (obj.type !== 'session') continue;
      if (typeof obj.cwd === 'string' && obj.cwd.trim()) return obj.cwd.trim();
    }
  } finally {
    // Reader has no explicit close; the underlying stream ends with iteration.
  }
  return null;
}

export interface ParseWpsComateResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseWpsComateIncremental(
  cursors: CursorsFile,
  statsSince: string,
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<{ result: ParseWpsComateResult; cursors: CursorsFile }> {
  const env = opts?.env ?? process.env;
  const sinceMs = new Date(statsSince).getTime();
  const ext = cursors as CursorsFile & { wpsComate?: WpsComateCursors };
  if (!ext.wpsComate) ext.wpsComate = { files: {}, seenIds: [] };
  if (!ext.wpsComate.files) ext.wpsComate.files = {};
  const fileCursors = ext.wpsComate.files;
  const seenIds = new Set(ext.wpsComate.seenIds ?? []);
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of findWpsComateSessionFiles(env)) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileCursors[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;
    if (sameInode && !truncated && startOffset >= st.size) continue;

    let project: string;
    if (sameInode && prev.project) {
      project = prev.project;
    } else {
      const cwd = await peekWpsComateCwd(filePath);
      project = cwd ? resolveProjectName(cwd) : 'unknown';
    }

    const reader = createJsonlLineReader(filePath, startOffset);
    const fileTag = filePath.split('/').pop() ?? filePath;

    for await (const line of reader) {
      if (!line.includes('"usage"')) continue;
      let entry: {
        id?: string;
        type?: string;
        timestamp?: unknown;
        message?: {
          role?: string;
          model?: unknown;
          responseModel?: unknown;
          timestamp?: unknown;
          usage?: Record<string, unknown>;
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'message') continue;
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant') continue;
      if (!msg.usage || typeof msg.usage !== 'object') continue;

      const entryId = typeof entry.id === 'string' && entry.id ? entry.id : null;
      if (!entryId) continue;
      const dedupKey = `${fileTag}:${entryId}`;
      if (seenIds.has(dedupKey)) continue;

      const delta = normalizeWpsComateUsage(msg.usage);
      if (!delta) {
        seenIds.add(dedupKey);
        continue;
      }

      const tsMs =
        coerceTimestampMs(msg.timestamp) ?? coerceTimestampMs(entry.timestamp);
      if (tsMs == null) {
        seenIds.add(dedupKey);
        continue;
      }

      const hourStart = toUtcHalfHourStart(new Date(tsMs).toISOString());
      if (!hourStart) {
        seenIds.add(dedupKey);
        continue;
      }
      if (new Date(hourStart).getTime() < sinceMs) {
        seenIds.add(dedupKey);
        continue;
      }

      const model = wpsComateModelName(msg.responseModel, msg.model);
      accumulateBucket(
        bucketState,
        'wps-comate',
        model,
        project,
        hourStart,
        { ...delta, conversation_count: 1 },
        WPS_COMATE_COLLECTOR,
      );
      seenIds.add(dedupKey);
      eventsParsed += 1;
    }

    fileCursors[filePath] = { inode, offset: reader.nextOffset, project };
    filesProcessed += 1;
  }

  ext.wpsComate.seenIds = Array.from(seenIds).slice(-50_000);

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'wps-comate'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

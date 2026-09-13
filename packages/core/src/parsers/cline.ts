/**
 * Cline (VS Code extension) passive reader (source `cline`, collector `cline`).
 *
 * Extension ID: saoudrizwan.claude-dev
 * Paths: …/globalStorage/saoudrizwan.claude-dev/state/taskHistory.json
 *        …/globalStorage/saoudrizwan.claude-dev/tasks/<id>/ui_messages.json
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
  splitRootsEnv,
} from './shared.js';
import { vscodeHostRoots } from './roocode.js';

export const CLINE_COLLECTOR = 'cline';

const EXTENSION_ID = 'saoudrizwan.claude-dev';
const CLINE_STORAGE = join('User', 'globalStorage', EXTENSION_ID);

type ClineExtCursors = CursorsFile & {
  cline?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
  };
};

export function findClineExtensionDirs(): string[] {
  const override = process.env.AI_USAGE_CLINE_ROOTS?.trim();
  if (override) return splitRootsEnv(override);
  const dirs: string[] = [];
  for (const root of vscodeHostRoots()) {
    const ext = join(root, CLINE_STORAGE);
    if (existsSync(ext)) dirs.push(ext);
  }
  return dirs;
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function projectFromPath(absPath: unknown): string {
  if (!absPath || typeof absPath !== 'string') return 'unknown';
  return resolveProjectName(absPath);
}

function toNonNeg(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

export interface ClineTaskTarget {
  extDir: string;
  taskId: string;
  project: string;
  fallbackModel: string;
  uiMessagesPath: string;
}

export function resolveClineTaskTargets(): ClineTaskTarget[] {
  const out: ClineTaskTarget[] = [];
  for (const extDir of findClineExtensionDirs()) {
    const history = readJsonSafe(join(extDir, 'state', 'taskHistory.json'));
    if (!Array.isArray(history)) continue;

    for (const item of history) {
      if (!item || typeof item !== 'object') continue;
      const row = item as {
        id?: unknown;
        cwdOnTaskInitialization?: unknown;
        shadowGitConfigWorkTree?: unknown;
        modelId?: unknown;
      };
      if (!row.id) continue;
      const taskId = String(row.id);
      const project = projectFromPath(row.cwdOnTaskInitialization ?? row.shadowGitConfigWorkTree);
      const fallbackModel =
        typeof row.modelId === 'string' && row.modelId.trim() ? row.modelId.trim() : 'unknown';
      const uiMessagesPath = join(extDir, 'tasks', taskId, 'ui_messages.json');
      if (!existsSync(uiMessagesPath)) continue;
      out.push({ extDir, taskId, project, fallbackModel, uiMessagesPath });
    }
  }
  out.sort((a, b) => a.uiMessagesPath.localeCompare(b.uiMessagesPath));
  return out;
}

export interface ParseClineResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseClineIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseClineResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const ext = cursors as ClineExtCursors;
  if (!ext.cline) {
    ext.cline = { seenIds: [], fileOffsets: {} };
  }
  if (!ext.cline.fileOffsets) ext.cline.fileOffsets = {};
  const seenIds = new Set(ext.cline.seenIds ?? []);
  const fileOffsets = ext.cline.fileOffsets;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const { taskId, project, fallbackModel, uiMessagesPath } of resolveClineTaskTargets()) {
    const st = await stat(uiMessagesPath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileOffsets[uiMessagesPath];
    if (
      prev &&
      prev.size === st.size &&
      prev.mtimeMs === st.mtimeMs &&
      prev.ino === st.ino
    ) {
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(uiMessagesPath, 'utf-8');
    } catch {
      continue;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(data)) continue;

    for (const msg of data) {
      if (!msg || typeof msg !== 'object') continue;
      const row = msg as { type?: string; say?: string; text?: string; ts?: unknown };
      if (row.type !== 'say' || row.say !== 'api_req_started') continue;
      if (typeof row.text !== 'string' || !row.text.startsWith('{')) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.text) as Record<string, unknown>;
      } catch {
        continue;
      }

      const ts = Number(row.ts);
      if (!Number.isFinite(ts) || ts <= 0) continue;

      const dedupKey = `${taskId}:${ts}`;
      if (seenIds.has(dedupKey)) continue;

      const tokensIn = toNonNeg(payload.tokensIn);
      const tokensOut = toNonNeg(payload.tokensOut);
      const cacheReads = toNonNeg(payload.cacheReads);
      const cacheWrites = toNonNeg(payload.cacheWrites);
      if (tokensIn === 0 && tokensOut === 0 && cacheReads === 0 && cacheWrites === 0) {
        continue;
      }

      const hourStart = toUtcHalfHourStart(new Date(ts).toISOString());
      if (!hourStart || new Date(hourStart).getTime() < sinceMs) continue;

      const deltaBody = {
        input_tokens: tokensIn,
        cached_input_tokens: cacheReads,
        cache_creation_input_tokens: cacheWrites,
        output_tokens: tokensOut,
        reasoning_output_tokens: 0,
      };
      const total = computeTotalTokens(deltaBody);
      const delta: TokenTotals = { ...deltaBody, total_tokens: total, conversation_count: 1 };

      const explicitModel = typeof payload.model === 'string' ? payload.model.trim() : '';
      const model = explicitModel || fallbackModel;
      accumulateBucket(bucketState, 'cline', model, project, hourStart, delta, CLINE_COLLECTOR);
      seenIds.add(dedupKey);
      eventsParsed += 1;
    }

    fileOffsets[uiMessagesPath] = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    filesProcessed += 1;
  }

  ext.cline.seenIds = Array.from(seenIds).slice(-50_000);

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'cline'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

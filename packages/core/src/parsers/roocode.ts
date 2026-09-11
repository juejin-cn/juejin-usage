/**
 * Roo Code (VS Code extension) passive reader (source `roocode`, collector `roo-code`).
 *
 * Path helpers to add in ../paths.ts:
 *   - vscodeHostRoots() — Application Support / APPDATA / XDG hosts:
 *     Code, Code - Insiders, Cursor, VSCodium, Windsurf, Trae, Trae CN, CodeBuddy
 *   - roocodeTasksDir(hostRoot) -> …/User/globalStorage/rooveterinaryinc.roo-cline/tasks
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  splitRootsEnv,
  type BucketAccumulator,
} from './shared.js';

export const ROOCODE_COLLECTOR = 'roo-code';

const ROOCODE_STORAGE = join('User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks');

type RoocodeExtCursors = CursorsFile & {
  roocode?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
  };
};

function appSupportBase(): string {
  const plat = platform();
  if (plat === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (plat === 'win32') {
    return process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

export function vscodeHostRoots(): string[] {
  const override = process.env.AI_USAGE_VSCODE_ROOTS?.trim();
  if (override) return splitRootsEnv(override);
  const base = appSupportBase();
  const names = [
    'Code',
    'Code - Insiders',
    'Cursor',
    'VSCodium',
    'Windsurf',
    'Trae',
    'Trae CN',
    'CodeBuddy',
  ];
  return names.map((name) => join(base, name));
}

export interface RoocodeTaskFile {
  filePath: string;
  taskUuid: string;
  ide: string;
}

export function resolveRoocodeTaskFiles(): RoocodeTaskFile[] {
  const out: RoocodeTaskFile[] = [];
  for (const root of vscodeHostRoots()) {
    const tasksDir = join(root, ROOCODE_STORAGE);
    if (!existsSync(tasksDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(tasksDir);
    } catch {
      continue;
    }
    for (const taskUuid of entries) {
      const filePath = join(tasksDir, taskUuid, 'ui_messages.json');
      if (!existsSync(filePath)) continue;
      out.push({ filePath, taskUuid, ide: basename(root) });
    }
  }
  out.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return out;
}

function readRoocodeTaskModel(uiMessagesPath: string): string | null {
  const historyPath = join(dirname(uiMessagesPath), 'api_conversation_history.json');
  let raw: string;
  try {
    raw = readFileSync(historyPath, 'utf-8');
  } catch {
    return null;
  }
  if (raw.length > 1_048_576) {
    const naive = raw.slice(raw.length - 1_048_576);
    const blockStart = naive.indexOf('<environment_details>');
    raw = blockStart >= 0 ? naive.slice(blockStart) : naive;
  }
  let lastModel: string | null = null;
  const re = /<model>\s*([^<\s][^<]*?)\s*<\/model>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const value = m[1]?.trim();
    if (value) lastModel = value;
  }
  return lastModel;
}

function normalizeRoocodeModel(explicitModel: string | null, apiProtocol: unknown): string {
  const trimmed = typeof explicitModel === 'string' ? explicitModel.trim() : '';
  if (trimmed) return trimmed;
  if (typeof apiProtocol === 'string' && apiProtocol.trim()) {
    const slug = apiProtocol.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (slug) return `protocol:${slug}`;
  }
  return 'unknown';
}

function toNonNeg(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

export interface ParseRoocodeResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseRoocodeIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseRoocodeResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const ext = cursors as RoocodeExtCursors;
  if (!ext.roocode) {
    ext.roocode = { seenIds: [], fileOffsets: {} };
  }
  if (!ext.roocode.fileOffsets) ext.roocode.fileOffsets = {};
  const seenIds = new Set(ext.roocode.seenIds ?? []);
  const fileOffsets = ext.roocode.fileOffsets;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const { filePath, taskUuid } of resolveRoocodeTaskFiles()) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileOffsets[filePath];
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
      raw = readFileSync(filePath, 'utf-8');
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

    const taskModel = readRoocodeTaskModel(filePath);

    for (const msg of data) {
      if (!msg || typeof msg !== 'object') continue;
      const row = msg as { say?: string; text?: string; ts?: unknown };
      if (row.say !== 'api_req_started' && row.say !== 'api_req_deleted') continue;
      if (typeof row.text !== 'string' || !row.text.startsWith('{')) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.text) as Record<string, unknown>;
      } catch {
        continue;
      }

      const ts = Number(row.ts);
      if (!Number.isFinite(ts) || ts <= 0) continue;

      const dedupKey = `${taskUuid}:${ts}`;
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

      const model = normalizeRoocodeModel(taskModel, payload.apiProtocol);
      accumulateBucket(bucketState, 'roocode', model, 'unknown', hourStart, delta, ROOCODE_COLLECTOR);
      seenIds.add(dedupKey);
      eventsParsed += 1;
    }

    fileOffsets[filePath] = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    filesProcessed += 1;
  }

  ext.roocode.seenIds = Array.from(seenIds).slice(-50_000);

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'roocode'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

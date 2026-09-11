/**
 * Kilo Code VS Code extension passive reader (source `kilocode`, collector `kilo-code`).
 *
 * Path: …/User/globalStorage/kilocode.kilo-code/tasks/<uuid>/ui_messages.json
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  splitRootsList,
  type BucketAccumulator,
} from './shared.js';
import { vscodeHostRoots } from './roocode.js';

export const KILOCODE_COLLECTOR = 'kilo-code';

const KILOCODE_STORAGE = join('User', 'globalStorage', 'kilocode.kilo-code', 'tasks');

type KilocodeExtCursors = CursorsFile & {
  kilocode?: {
    seenIds?: string[];
    fileOffsets?: Record<string, { size: number; mtimeMs: number; ino: number }>;
  };
};

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function kilocodeHostRoots(): string[] {
  const override =
    process.env.AI_USAGE_KILOCODE_ROOTS?.trim() ||
    process.env.AI_USAGE_VSCODE_ROOTS?.trim();
  if (override) {
    return splitRootsList(override).map((p) => expandHome(p));
  }
  return vscodeHostRoots();
}

export interface KilocodeTaskFile {
  filePath: string;
  taskUuid: string;
  ide: string;
}

export function resolveKilocodeTaskFiles(): KilocodeTaskFile[] {
  const out: KilocodeTaskFile[] = [];
  for (const root of kilocodeHostRoots()) {
    const tasksDir = join(root, KILOCODE_STORAGE);
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

/** Map inference provider name to a dashboard model slug. */
export function normalizeKilocodeProviderToModel(providerName: unknown): string {
  if (typeof providerName !== 'string' || !providerName.trim()) return 'provider:unknown';
  const slug = providerName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
  if (!slug || !/[a-z0-9]/.test(slug)) return 'provider:unknown';
  return `provider:${slug}`;
}

function toNonNeg(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

export interface ParseKilocodeResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseKilocodeIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseKilocodeResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const ext = cursors as KilocodeExtCursors;
  if (!ext.kilocode) {
    ext.kilocode = { seenIds: [], fileOffsets: {} };
  }
  if (!ext.kilocode.fileOffsets) ext.kilocode.fileOffsets = {};
  const seenIds = new Set(ext.kilocode.seenIds ?? []);
  const fileOffsets = ext.kilocode.fileOffsets;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const { filePath, taskUuid } of resolveKilocodeTaskFiles()) {
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

      const model = normalizeKilocodeProviderToModel(payload.inferenceProvider);
      accumulateBucket(bucketState, 'kilocode', model, 'unknown', hourStart, delta, KILOCODE_COLLECTOR);
      seenIds.add(dedupKey);
      eventsParsed += 1;
    }

    fileOffsets[filePath] = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    filesProcessed += 1;
  }

  ext.kilocode.seenIds = Array.from(seenIds).slice(-50_000);

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'kilocode'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

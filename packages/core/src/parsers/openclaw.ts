/**
 * paths.ts exports needed:
 *   openclawRoots(): string[]  — OPENCLAW_STATE_DIR or ~/.openclaw*, legacy clawdbot/moltbot/moldbot
 *   findOpenclawSessionFiles(roots?: string[]): string[]  — agents/<id>/sessions/*.jsonl
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
} from './shared.js';
import { AUTOCLAW_PROFILE_DIR } from './autoclaw.js';

export const OPENCLAW_COLLECTOR = 'openclaw';

interface OpenclawFileCursor {
  inode: number;
  offset: number;
}

function toNonNeg(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function getUsageField(usage: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const v = usage[key];
    if (v != null && toNonNeg(v) > 0) return toNonNeg(v);
  }
  return 0;
}

/** OpenClaw wraps Codex-style usage where raw input includes cache reads. */
export function normalizeOpenclawUsage(
  usage: Record<string, unknown> | null | undefined,
): Omit<TokenTotals, 'conversation_count'> | null {
  if (!usage || typeof usage !== 'object') return null;

  const rawInput = getUsageField(
    usage,
    'input',
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens',
  );
  const cacheRead = getUsageField(
    usage,
    'cacheRead',
    'cache_read',
    'cache_read_input_tokens',
    'cachedInputTokens',
    'cached_input_tokens',
  );
  const cacheWrite = getUsageField(
    usage,
    'cacheWrite',
    'cache_write',
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
  );
  const output = getUsageField(
    usage,
    'output',
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
  );

  const input = Math.max(0, rawInput - cacheRead);
  const delta = {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: 0,
  };
  const total = computeTotalTokens(delta);
  if (total === 0) return null;
  return { ...delta, total_tokens: total };
}

function coerceTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** All OpenClaw state roots (OPENCLAW_STATE_DIR overrides to a single root). */
export function openclawRoots(): string[] {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  if (env) {
    const root = env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
    return [root];
  }

  const home = homedir();
  const roots: string[] = [
    join(home, '.clawdbot'),
    join(home, '.moltbot'),
    join(home, '.moldbot'),
  ];
  const seen = new Set(roots);

  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // AutoClaw profile dirs are owned by the autoclaw parser.
      if (AUTOCLAW_PROFILE_DIR.test(entry.name)) continue;
      if (entry.name === '.openclaw' || /^\.openclaw-.+/.test(entry.name)) {
        const full = join(home, entry.name);
        if (!seen.has(full)) {
          seen.add(full);
          roots.push(full);
        }
      }
    }
  } catch {
    // ignore unreadable home
  }

  return roots;
}

/** Discover session JSONL files under agents/<id>/sessions/. */
export function findOpenclawSessionFiles(roots = openclawRoots()): string[] {
  const results: string[] = [];
  for (const root of roots) {
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentDirs;
    try {
      agentDirs = readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    for (const agentDir of agentDirs) {
      const sessionsDir = join(agentsDir, agentDir.name, 'sessions');
      if (!existsSync(sessionsDir)) continue;

      let files: string[];
      try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        results.push(join(sessionsDir, file));
      }
    }
  }
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

function projectFromPath(filePath: string): string {
  // …/agents/<agentId>/sessions/<session>.jsonl
  const parts = filePath.split(/[/\\]/);
  const agentsIdx = parts.lastIndexOf('agents');
  if (agentsIdx >= 0 && parts[agentsIdx + 1]) return parts[agentsIdx + 1]!;
  return basename(filePath, '.jsonl') || 'unknown';
}

export interface ParseOpenclawResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseOpenclawIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseOpenclawResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const openclaw = (cursors as CursorsFile & { openclaw?: { files: Record<string, OpenclawFileCursor> } })
    .openclaw;
  if (!openclaw) {
    (cursors as CursorsFile & { openclaw: { files: Record<string, OpenclawFileCursor> } }).openclaw = {
      files: {},
    };
  }
  const fileCursors = (
    cursors as CursorsFile & { openclaw: { files: Record<string, OpenclawFileCursor> } }
  ).openclaw.files;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of findOpenclawSessionFiles()) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileCursors[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;
    if (sameInode && !truncated && startOffset >= st.size) continue;

    const project = projectFromPath(filePath);
    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!line.includes('"usage"')) continue;

      let obj: {
        type?: string;
        timestamp?: unknown;
        model?: string;
        message?: {
          role?: string;
          model?: string;
          timestamp?: unknown;
          usage?: Record<string, unknown>;
        };
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== 'message') continue;
      const msg = obj.message;
      if (!msg || msg.role !== 'assistant') continue;

      const delta = normalizeOpenclawUsage(msg.usage);
      if (!delta) continue;

      const stamp =
        coerceTimestamp(obj.timestamp) ??
        coerceTimestamp(msg.timestamp);
      if (!stamp) continue;

      const hourStart = toUtcHalfHourStart(stamp);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const model = msg.model || obj.model || 'unknown';
      accumulateBucket(
        bucketState,
        'openclaw',
        model,
        project,
        hourStart,
        { ...delta, conversation_count: 1 },
        OPENCLAW_COLLECTOR,
      );
      eventsParsed += 1;
    }

    fileCursors[filePath] = { inode, offset: st.size };
    filesProcessed += 1;
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'openclaw'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

/**
 * AutoClaw passive reader (source `autoclaw`, collector `autoclaw`).
 *
 * AutoClaw is an OpenClaw-family product whose state root defaults to
 * ~/.openclaw-autoclaw (OpenClaw agent profile "autoclaw"); ~/.autoclaw is
 * accepted as an alternate layout. Session JSONL matches OpenClaw's format:
 * agents/<agentId>/sessions/*.jsonl with OpenClaw-style wrapped usage, so the
 * normalization is shared with the OpenClaw parser.
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket } from '../types.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  type BucketAccumulator,
} from './shared.js';
import { normalizeOpenclawUsage } from './openclaw.js';

export const AUTOCLAW_COLLECTOR = 'autoclaw';

interface AutoclawFileCursor {
  inode: number;
  offset: number;
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

/** Directories owned by this parser; the OpenClaw scanner must skip them. */
export const AUTOCLAW_PROFILE_DIR = /^\.openclaw-autoclaw(?:-.+)?$/;

/** All AutoClaw state roots (AUTOCLAW_STATE_DIR overrides to a single root). */
export function autoclawRoots(): string[] {
  const env = process.env.AUTOCLAW_STATE_DIR?.trim();
  if (env) {
    const root = env.startsWith('~') ? join(homedir(), env.slice(1)) : env;
    return [root];
  }

  const home = homedir();
  const roots: string[] = [join(home, '.autoclaw'), join(home, '.openclaw-autoclaw')];
  const seen = new Set(roots);

  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (/^\.autoclaw-.+/.test(entry.name) || AUTOCLAW_PROFILE_DIR.test(entry.name)) {
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
export function findAutoclawSessionFiles(roots = autoclawRoots()): string[] {
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

export interface ParseAutoclawResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseAutoclawIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseAutoclawResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const autoclaw = (cursors as CursorsFile & { autoclaw?: { files: Record<string, AutoclawFileCursor> } })
    .autoclaw;
  if (!autoclaw) {
    (cursors as CursorsFile & { autoclaw: { files: Record<string, AutoclawFileCursor> } }).autoclaw = {
      files: {},
    };
  }
  const fileCursors = (
    cursors as CursorsFile & { autoclaw: { files: Record<string, AutoclawFileCursor> } }
  ).autoclaw.files;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of findAutoclawSessionFiles()) {
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
        'autoclaw',
        model,
        project,
        hourStart,
        { ...delta, conversation_count: 1 },
        AUTOCLAW_COLLECTOR,
      );
      eventsParsed += 1;
    }

    fileCursors[filePath] = { inode, offset: st.size };
    filesProcessed += 1;
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'autoclaw'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

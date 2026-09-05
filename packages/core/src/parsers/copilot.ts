import { existsSync, readdirSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { copilotSessionStateDir } from '../paths.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  type BucketAccumulator,
} from './shared.js';

export const COPILOT_COLLECTOR = 'copilot-cli';

function getProjectFromContext(context: Record<string, unknown> | undefined): string {
  const projectPath = (context?.gitRoot ?? context?.cwd) as string | undefined;
  if (!projectPath) return 'unknown';
  return resolveProjectName(projectPath);
}

export function findCopilotEventFiles(
  baseDir = copilotSessionStateDir(),
): Array<{ filePath: string; sessionId: string }> {
  const results: Array<{ filePath: string; sessionId: string }> = [];
  if (!existsSync(baseDir)) return results;
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const eventsFile = join(baseDir, entry.name, 'events.jsonl');
      if (existsSync(eventsFile)) {
        results.push({ filePath: eventsFile, sessionId: entry.name });
      }
    }
  } catch {
    return results;
  }
  return results;
}

function normalizeShutdownUsage(usage: Record<string, unknown>): TokenTotals | null {
  const totalInput = Math.max(0, Math.floor(Number(usage.inputTokens) || 0));
  const cachedRead = Math.max(0, Math.floor(Number(usage.cacheReadTokens) || 0));
  const cacheWrite = Math.max(0, Math.floor(Number(usage.cacheWriteTokens) || 0));
  const output = Math.max(0, Math.floor(Number(usage.outputTokens) || 0));
  const delta = {
    input_tokens: Math.max(0, totalInput - cachedRead),
    output_tokens: output,
    cached_input_tokens: cachedRead,
    cache_creation_input_tokens: cacheWrite,
    reasoning_output_tokens: 0,
  };
  const total = computeTotalTokens(delta);
  if (total === 0) return null;
  return { ...delta, total_tokens: total, conversation_count: 1 };
}

export interface ParseCopilotResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseCopilotIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseCopilotResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  if (!cursors.copilot) {
    cursors.copilot = { files: {}, seenHashes: [] };
  }
  const fileCursors = cursors.copilot.files ?? (cursors.copilot.files = {});
  const seenHashes = new Set(cursors.copilot.seenHashes ?? []);
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const { filePath, sessionId } of findCopilotEventFiles()) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileCursors[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;
    if (sameInode && !truncated && startOffset >= st.size) continue;

    // Usage only arrives on session.shutdown, while the project only appears
    // on session.start/resume lines an earlier scan may have consumed; when
    // resuming mid-file, restore it from the cursor instead of 'unknown'.
    let currentProject =
      startOffset > 0 ? (prev?.project ?? 'unknown') : 'unknown';
    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: {
        type?: string;
        timestamp?: string;
        data?: {
          context?: Record<string, unknown>;
          modelMetrics?: Record<string, { usage?: Record<string, unknown> }>;
        };
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type === 'session.start' || obj.type === 'session.resume') {
        currentProject = getProjectFromContext(obj.data?.context);
        continue;
      }

      if (obj.type !== 'session.shutdown') continue;
      const stamp = obj.timestamp;
      if (!stamp) continue;
      const hourStart = toUtcHalfHourStart(stamp);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const modelMetrics = obj.data?.modelMetrics || {};
      for (const [model, metrics] of Object.entries(modelMetrics)) {
        const usage = metrics?.usage;
        if (!usage) continue;
        const delta = normalizeShutdownUsage(usage);
        if (!delta) continue;

        const dedup = `${sessionId}|shutdown|${stamp}|${model}`;
        if (seenHashes.has(dedup)) continue;
        seenHashes.add(dedup);

        accumulateBucket(
          bucketState,
          'copilot',
          model || 'unknown',
          currentProject,
          hourStart,
          delta,
          COPILOT_COLLECTOR,
        );
        eventsParsed += 1;
      }
    }

    fileCursors[filePath] = { inode, offset: st.size, project: currentProject };
    filesProcessed += 1;
  }

  cursors.copilot.seenHashes = Array.from(seenHashes).slice(-50_000);

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'copilot'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

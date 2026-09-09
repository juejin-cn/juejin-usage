import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { qwenworkProjectsDirs } from '../paths.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  computeTotalTokens,
  findJsonlFiles,
  type BucketAccumulator,
} from './shared.js';

export const QWENWORK_COLLECTOR = 'qwenwork';

/**
 * QwenWork session log segment event.
 * Usage is reported per-turn in `turn.finished` events.
 */
interface QwenWorkTurnFinished {
  ts: string;
  type: 'turn.finished';
  turn_id: string;
  data: {
    reason?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    model?: string;
  };
}

interface QwenWorkTurnStarted {
  ts: string;
  type: 'turn.started';
  turn_id: string;
  data: {
    model?: string;
  };
}

type QwenWorkEvent = QwenWorkTurnFinished | QwenWorkTurnStarted | Record<string, unknown>;

const MAX_SEEN_TURNS = 50_000;

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeQwenWorkUsage(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): TokenTotals {
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

function capSeenTurns(seen: Record<string, TokenTotals>): Record<string, TokenTotals> {
  const keys = Object.keys(seen);
  if (keys.length <= MAX_SEEN_TURNS) return seen;
  const drop = keys.length - MAX_SEEN_TURNS;
  const next: Record<string, TokenTotals> = {};
  for (const key of keys.slice(drop)) {
    next[key] = seen[key]!;
  }
  return next;
}

/**
 * Resolve project name from the session directory path.
 * Path format: `logs/sessions/<encoded-project-path>/<sessionId>/segments/...`
 * e.g., `C--Users-wucy0` → `C:\Users\wucy0`
 */
function resolveQwenworkProject(sessionDirName: string): string {
  // Decode the path: `--` → `:\` or similar encoding
  // Actual format: `C--Users-wucy0` means `C:\Users\wucy0`
  const decoded = sessionDirName.replace(/--/g, '/').replace(/-/g, '\\');
  return resolveProjectName(decoded);
}

export async function listQwenworkSegmentFiles(): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const projectsDir of qwenworkProjectsDirs()) {
    // Segment files are at: <root>/logs/sessions/*/segments/*.jsonl
    const logsDir = `${projectsDir.replace(/\\/g, '/')}/logs/sessions`;
    for (const f of await findJsonlFiles(logsDir)) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }
  return files.sort();
}

export interface ParseQwenworkResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
}

export async function parseQwenworkIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseQwenworkResult; cursors: CursorsFile }> {
  const files = await listQwenworkSegmentFiles();
  const sinceMs = new Date(statsSince).getTime();

  if (!cursors.qwenwork) {
    cursors.qwenwork = { files: {}, seenTurns: {} };
  }
  const qwCursor = cursors.qwenwork;
  if (!qwCursor.seenTurns) qwCursor.seenTurns = {};
  const seenTurns = qwCursor.seenTurns;
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  // Track model per turn within each file
  const turnModel = new Map<string, string>();

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = qwCursor.files[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;

    if (sameInode && !truncated && startOffset >= st.size) {
      continue;
    }

    // Extract project from path: .../sessions/<project>/<sessionId>/segments/file.jsonl
    const parts = filePath.replace(/\\/g, '/').split('/');
    let project = 'unknown';
    const sessionsIdx = parts.indexOf('sessions');
    if (sessionsIdx >= 0 && parts.length > sessionsIdx + 1) {
      project = resolveQwenworkProject(parts[sessionsIdx + 1]!);
    }

    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.includes('"type"')) continue;
      let obj: QwenWorkEvent;
      try {
        obj = JSON.parse(line) as QwenWorkEvent;
      } catch {
        continue;
      }

      const type = obj.type as string | undefined;
      const turnId = (obj as { turn_id?: string }).turn_id;
      const data = (obj as { data?: Record<string, unknown> }).data;

      if (!turnId || !data) continue;

      if (type === 'turn.started') {
        const model = data.model as string | undefined;
        if (model) {
          turnModel.set(turnId, model);
        }
        continue;
      }

      if (type !== 'turn.finished') continue;

      // Skip if we've already seen this turn
      if (seenTurns[turnId]) continue;

      const inputTokens = toCount(data.input_tokens);
      const outputTokens = toCount(data.output_tokens);
      const cacheRead = toCount(data.cache_read_input_tokens);
      const cacheCreation = toCount(data.cache_creation_input_tokens);

      if (inputTokens + outputTokens + cacheRead + cacheCreation === 0) continue;

      const ts = (obj as { ts?: string }).ts;
      if (!ts) continue;
      const hourStart = toUtcHalfHourStart(ts);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const model = data.model as string | undefined || turnModel.get(turnId) || 'unknown';
      const totals = normalizeQwenWorkUsage(inputTokens, outputTokens, cacheRead, cacheCreation);

      seenTurns[turnId] = totals;
      accumulateBucket(
        bucketState,
        'qwenwork',
        model,
        project,
        hourStart,
        totals,
        QWENWORK_COLLECTOR,
      );
      eventsParsed += 1;
    }

    rl.close();
    stream.destroy();

    qwCursor.files[filePath] = {
      inode,
      offset: st.size,
      project,
    };
    filesProcessed += 1;
  }

  capSeenTurns(seenTurns);

  return {
    result: {
      buckets: bucketsFromState(bucketState, QWENWORK_COLLECTOR),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

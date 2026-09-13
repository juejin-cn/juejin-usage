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
 * QwenWork session JSONL message.
 * Contains the actual input/output content.
 */
interface QwenWorkMessage {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: Array<{
      type?: string;
      text?: string;
      input?: unknown;
      name?: string;
    }>;
  };
}

/**
 * Estimate token count from text content.
 * Heuristic: Chinese chars ≈ 1 token, English/mixed ≈ 2.5 chars per token.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let chineseCount = 0;
  let otherCount = 0;
  for (const char of text) {
    if (char >= '\u4e00' && char <= '\u9fff') {
      chineseCount++;
    } else {
      otherCount++;
    }
  }
  // Chinese: ~1 token per char, English/other: ~3 chars per token
  return chineseCount + Math.ceil(otherCount / 3);
}

/**
 * Calculate total character content from a message's content blocks.
 */
function calculateContentTokens(content: Array<{ type?: string; text?: string; input?: unknown; name?: string }> | undefined): number {
  if (!content || !Array.isArray(content)) return 0;
  let totalText = '';
  for (const block of content) {
    if (block.text) {
      totalText += block.text;
    }
    if (block.input && typeof block.input === 'object') {
      totalText += JSON.stringify(block.input);
    }
    if (block.name) {
      totalText += block.name;
    }
  }
  return estimateTokens(totalText);
}

/**
 * Resolve project name from the session directory path.
 * Path format: `<root>/projects/<encoded-project-path>/<sessionId>.jsonl`
 * e.g., `C--Users-wucy0` → `C:\Users\wucy0`
 */
function resolveQwenworkProject(sessionDirName: string): string {
  const decoded = sessionDirName.replace(/--/g, '/').replace(/-/g, '\\');
  return resolveProjectName(decoded);
}

/**
 * Extract sessionId from file path.
 * Path format: `<root>/projects/<project>/<sessionId>.jsonl`
 */
function extractSessionId(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const fileName = parts[parts.length - 1];
  return fileName?.replace('.jsonl', '') || 'unknown';
}

export async function listQwenworkSessionFiles(): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const projectsDir of qwenworkProjectsDirs()) {
    // Session files are at: <root>/projects/*/*.jsonl
    for (const f of await findJsonlFiles(projectsDir)) {
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
  const files = await listQwenworkSessionFiles();
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

    // Extract project from path
    const parts = filePath.replace(/\\/g, '/').split('/');
    let project = 'unknown';
    const projectsIdx = parts.indexOf('projects');
    if (projectsIdx >= 0 && parts.length > projectsIdx + 1) {
      project = resolveQwenworkProject(parts[projectsIdx + 1]!);
    }

    const sessionId = extractSessionId(filePath);
    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.includes('"type"')) continue;
      let obj: QwenWorkMessage;
      try {
        obj = JSON.parse(line) as QwenWorkMessage;
      } catch {
        continue;
      }

      // Only process assistant messages (these contain the model output)
      if (obj.type !== 'assistant') continue;

      const msg = obj.message;
      if (!msg || msg.role !== 'assistant') continue;

      // Use messageId + sessionId for dedup
      const msgId = msg.id || `${sessionId}-${eventsParsed}`;
      if (seenTurns[msgId]) continue;

      // Calculate output tokens from content
      const outputTokens = calculateContentTokens(msg.content);
      if (outputTokens === 0) continue;

      // Estimate input tokens: roughly proportional to output for most conversations
      // For tool_use messages, include the tool input size
      let inputTokens = Math.ceil(outputTokens * 2); // rough estimate: input is ~2x output

      const ts = obj.timestamp;
      if (!ts) continue;
      const hourStart = toUtcHalfHourStart(ts);
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const model = msg.model || 'unknown';
      const body = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
      };
      const totals: TokenTotals = {
        ...body,
        total_tokens: computeTotalTokens(body),
        conversation_count: 1,
      };

      seenTurns[msgId] = totals;
      accumulateBucket(
        bucketState,
        'qwenwork',
        model,
        project,
        hourStart,
        totals,
        QWENWORK_COLLECTOR,
      );
      eventsParsed++;
    }

    rl.close();
    stream.destroy();

    qwCursor.files[filePath] = {
      inode,
      offset: st.size,
      project,
    };
    filesProcessed++;
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, QWENWORK_COLLECTOR),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

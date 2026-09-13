/**
 * QwenWork passive reader (source `qwenwork`).
 *
 * Session JSONL: `<root>/projects/<encoded-project-path>/<sessionId>.jsonl`
 * where `<root>` is `~/.qwenwork` (international) or `~/.qwenworkcn` (CN).
 *
 * ## Why everything here is estimated
 *
 * The transcript does **not** carry any per-request usage metadata — assistant
 * messages only expose `id/type/role/model/stop_reason/stop_sequence/content`.
 * So unlike `qwen.ts` (which reads `usageMetadata`) we must reconstruct the
 * numbers from the transcript itself.
 *
 * ## How the reconstruction works
 *
 * 1. **Fragment aggregation.** A single assistant turn is streamed to disk as
 *    2–3 records that share one `message.id` (verified: 170 ids / 432 records).
 *    The first fragment is always `thinking`; later ones carry `tool_use` and
 *    `text`. We therefore aggregate every fragment of a `message.id` before
 *    billing it once. Treating `message.id` as a dedup key (the previous
 *    implementation) silently dropped ~60% of the content.
 *
 * 2. **Chronological context reconstruction.** We replay records in file order
 *    and keep a running estimate of the logical context (`contextTokens`).
 *    A turn's `input_tokens` is the whole context at that moment, because the
 *    model re-sends the entire conversation on every call. After billing a
 *    turn its own output/reasoning join the context for the *next* call.
 *    `parentUuid` is deliberately **not** used for accumulation: it describes
 *    transcript linkage, not a linear context chain (assistant(tool_use) and
 *    the following user(tool_result) share one parent).
 *
 * 3. **Compact anchor.** `system`/`compact_boundary` records are the only real
 *    token figures in the file. When the conversation is compacted we reset
 *    `contextTokens` to `compactMetadata.postTokens`. `preTokens` is never
 *    billed — it is the size of the context that was just discarded.
 *
 * The resulting numbers are an **estimate of what the model was charged**, not
 * an exact billing figure.
 */
import { readFile, stat } from 'node:fs/promises';

import type { CursorsFile, QwenworkPendingTurn, QueueBucket, TokenTotals } from '../types.js';
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

/** Cap on un-flushed turns carried across syncs, to bound cursors.json size. */
const MAX_PENDING_TURNS = 200;
/** Per-block character cap; guards against pathologically large tool payloads. */
const MAX_BLOCK_CHARS = 2_000_000;

/** A content block inside an assistant or user message. */
interface QwenContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** One JSONL record. Only the shapes we consume are modelled. */
interface QwenRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    /** `null` on intermediate fragments; `tool_use` / `end_turn` close a turn. */
    stop_reason?: string | null;
    content?: QwenContentBlock[];
  };
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    messagesSummarized?: number;
    postTokens?: number;
    durationMs?: number;
  };
}

export function isQwenCjkCodePoint(code: number | undefined): boolean {
  if (code == null) return false;
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation (、。「」…)
    (code >= 0x3040 && code <= 0x30ff) || // hiragana / katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xff00 && code <= 0xffef) // fullwidth / halfwidth forms
  );
}

/**
 * CJK ≈ 1 token/char; everything else ≈ ceil(chars / 4). Upper-bound estimate
 * (there is no cache discount to apply).
 */
export function estimateQwenworkTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isQwenCjkCodePoint(ch.codePointAt(0))) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** Token estimate for an arbitrary JSON value (string passes through). */
function qwenValueTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return estimateQwenworkTokens(value);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return 0;
  }
  if (!json) return 0;
  return estimateQwenworkTokens(json.slice(0, MAX_BLOCK_CHARS));
}

/**
 * Split aggregated blocks into reasoning text (thinking) and body text
 * (text + tool_use name/input). Keeping them apart matters: `computeTotalTokens`
 * sums the five fields without dedup, so reasoning must not leak into output.
 */
function qwenBlocksText(blocks: QwenContentBlock[]): { thinking: string; body: string } {
  let thinking = '';
  let body = '';
  for (const block of blocks) {
    switch (block.type) {
      case 'thinking':
        thinking += block.thinking ?? block.text ?? '';
        break;
      case 'text':
        body += block.text ?? '';
        break;
      case 'tool_use':
        body += block.name ?? '';
        if (block.input !== undefined) {
          try {
            body += JSON.stringify(block.input) ?? '';
          } catch {
            // circular / unserialisable input: skip its body contribution
          }
        }
        break;
      default:
        break;
    }
  }
  return { thinking, body };
}

/** Resolve project name from the encoded session directory name. */
function resolveQwenworkProject(sessionDirName: string): string {
  const decoded = sessionDirName.replace(/--/g, '/').replace(/-/g, '\\');
  return resolveProjectName(decoded);
}

export async function listQwenworkSessionFiles(): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const projectsDir of qwenworkProjectsDirs()) {
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

type QwenworkFileCursor = NonNullable<CursorsFile['qwenwork']>['files'][string];

interface FileParseOutcome {
  lastLine: number;
  contextTokens: number;
  lastModel: string | null;
  pending: QwenworkPendingTurn[];
  events: number;
}

/** Mutable per-file state while replaying records. */
interface FileState {
  contextTokens: number;
  lastModel: string | null;
  pending: Map<string, QwenworkPendingTurn>;
  events: number;
}

/**
 * Bill one aggregated assistant turn.
 *
 * `input_tokens` is the full context before this turn's own output is folded
 * in — the model re-sends the whole conversation on every call.
 */
function flushTurn(
  turn: QwenworkPendingTurn,
  state: FileState,
  collector: string,
  project: string,
  sinceMs: number,
  bucketState: BucketAccumulator,
): void {
  const { thinking, body } = qwenBlocksText(turn.blocks);
  const inputTokens = state.contextTokens;
  const reasoningTokens = estimateQwenworkTokens(thinking);
  const outputTokens = estimateQwenworkTokens(body);

  const body2 = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    // QwenWork transcript does not expose cache usage metadata.
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: reasoningTokens,
  };
  const total = computeTotalTokens(body2);

  const hourStart = turn.hourStart;
  if (hourStart && total > 0 && new Date(hourStart).getTime() >= sinceMs) {
    const totals: TokenTotals = {
      ...body2,
      total_tokens: total,
      conversation_count: 1,
    };
    accumulateBucket(bucketState, 'qwenwork', turn.model, project, hourStart, totals, collector);
    state.events += 1;
  }

  // This turn's output becomes part of the context for the next request.
  state.contextTokens += reasoningTokens + outputTokens;
}

function flushAllPending(
  state: FileState,
  collector: string,
  project: string,
  sinceMs: number,
  bucketState: BucketAccumulator,
): void {
  for (const turn of state.pending.values()) {
    flushTurn(turn, state, collector, project, sinceMs, bucketState);
  }
  state.pending.clear();
}

/**
 * Replay one session file from `resume.lastLine`, rebuilding the logical
 * context and emitting buckets for assistant turns that have settled.
 */
async function parseQwenworkFile(opts: {
  filePath: string;
  resume: QwenworkFileCursor | null;
  collector: string;
  project: string;
  sinceMs: number;
  bucketState: BucketAccumulator;
}): Promise<FileParseOutcome> {
  const { filePath, resume, collector, project, sinceMs, bucketState } = opts;

  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    raw = '';
  }

  const lines = raw.split(/\r?\n/);
  // A trailing newline produces one empty final element; keep it out of the
  // line count so `lastLine` stays comparable across syncs.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const resumable =
    resume != null &&
    typeof resume.lastLine === 'number' &&
    resume.lastLine > 0 &&
    resume.lastLine <= lines.length;

  const state: FileState = {
    contextTokens: resumable ? resume.contextTokens : 0,
    lastModel: resumable ? resume.lastModel : null,
    pending: new Map(),
    events: 0,
  };
  if (resumable && Array.isArray(resume.pendingTurns)) {
    for (const turn of resume.pendingTurns) {
      state.pending.set(turn.messageId, { ...turn, blocks: [...turn.blocks] });
    }
  }

  let lastCompletedLine = resumable ? resume.lastLine : 0;

  for (let i = lastCompletedLine; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      lastCompletedLine = i + 1;
      continue;
    }

    let rec: QwenRecord;
    try {
      rec = JSON.parse(line) as QwenRecord;
    } catch {
      // Partial / corrupt line at the append frontier: stop so the next sync
      // retries from here instead of persisting a half line.
      break;
    }

    // Sub-agent transcripts live in their own files; ignore defensively.
    if (rec.isSidechain === true) {
      lastCompletedLine = i + 1;
      continue;
    }

    if (rec.type === 'assistant') {
      const msg = rec.message;
      if (!msg || msg.role !== 'assistant') {
        lastCompletedLine = i + 1;
        continue;
      }
      const msgId = msg.id ?? rec.uuid ?? null;
      if (!msgId) {
        lastCompletedLine = i + 1;
        continue;
      }
      let turn = state.pending.get(msgId);
      if (!turn) {
        turn = {
          messageId: msgId,
          model: msg.model ?? state.lastModel ?? 'unknown',
          startedAt: rec.timestamp ?? null,
          hourStart: rec.timestamp ? toUtcHalfHourStart(rec.timestamp) : null,
          blocks: [],
          complete: false,
        };
        state.pending.set(msgId, turn);
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) turn.blocks.push(block);
      }
      if (msg.model) {
        turn.model = msg.model;
        state.lastModel = msg.model;
      }
      // A non-null `stop_reason` marks the turn as fully written. Verified on a
      // real session: every one of the 170 message.ids had exactly one such
      // record (165 `tool_use` + 5 `end_turn`), the rest being `null`.
      if (msg.stop_reason != null) turn.complete = true;
      lastCompletedLine = i + 1;
      continue;
    }

    if (rec.type === 'user') {
      // A user record (real input or tool_result) closes the previous turn.
      flushAllPending(state, collector, project, sinceMs, bucketState);
      const blocks = rec.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            state.contextTokens += qwenValueTokens(block.content);
          } else if (block.type === 'text') {
            state.contextTokens += estimateQwenworkTokens(block.text ?? '');
          }
          // `image` carries no size metadata; skip rather than guess.
        }
      }
      lastCompletedLine = i + 1;
      continue;
    }

    if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
      flushAllPending(state, collector, project, sinceMs, bucketState);
      const post = rec.compactMetadata?.postTokens;
      // Hard anchor: the transcript tells us the context size right after
      // compaction. Ignore a missing/non-finite value rather than zeroing.
      if (typeof post === 'number' && Number.isFinite(post) && post >= 0) {
        state.contextTokens = post;
      }
      lastCompletedLine = i + 1;
      continue;
    }

    // attachment / file-history-snapshot / active-leaf / workspace-directories /
    // runtime-config / last-prompt: local bookkeeping, never sent to the model.
    // Billing them (notably file-history-snapshot) would wildly overstate input.
    lastCompletedLine = i + 1;
  }

  // The final turn has no following `user` record to close it. Bill the ones the
  // transcript marked complete; keep the rest so the next sync can finish them.
  for (const turn of state.pending.values()) {
    if (turn.complete) {
      flushTurn(turn, state, collector, project, sinceMs, bucketState);
      state.pending.delete(turn.messageId);
    }
  }

  const pending = Array.from(state.pending.values());
  // Never let an unbounded pending set bloat cursors.json.
  const cappedPending =
    pending.length > MAX_PENDING_TURNS
      ? pending.slice(pending.length - MAX_PENDING_TURNS)
      : pending;

  return {
    lastLine: lastCompletedLine,
    contextTokens: state.contextTokens,
    lastModel: state.lastModel,
    pending: cappedPending,
    events: state.events,
  };
}

export async function parseQwenworkIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseQwenworkResult; cursors: CursorsFile }> {
  const files = await listQwenworkSessionFiles();
  const sinceMs = new Date(statsSince).getTime();

  if (!cursors.qwenwork) {
    cursors.qwenwork = { files: {} };
  }
  const qwCursor = cursors.qwenwork;
  if (!qwCursor.files) qwCursor.files = {};

  const bucketState: BucketAccumulator = new Map();
  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of files) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = qwCursor.files[filePath];
    const inode = st.ino;
    const size = st.size;
    const mtimeMs = st.mtimeMs;

    // Unchanged since last sync: nothing to replay.
    if (
      prev &&
      typeof prev.lastLine === 'number' &&
      prev.inode === inode &&
      prev.size === size &&
      prev.mtimeMs === mtimeMs
    ) {
      filesProcessed += 1;
      continue;
    }

    // A truncated / rewritten file invalidates the replayed context.
    const sameFile =
      prev != null && prev.inode === inode && typeof prev.lastLine === 'number' && size >= prev.size;
    const resume = sameFile ? prev : null;

    const parts = filePath.replace(/\\/g, '/').split('/');
    let project = 'unknown';
    const projectsIdx = parts.indexOf('projects');
    if (projectsIdx >= 0 && parts.length > projectsIdx + 1) {
      project = resolveQwenworkProject(parts[projectsIdx + 1]!);
    }

    const outcome = await parseQwenworkFile({
      filePath,
      resume,
      collector: QWENWORK_COLLECTOR,
      project,
      sinceMs,
      bucketState,
    });

    qwCursor.files[filePath] = {
      inode,
      size,
      mtimeMs,
      lastLine: outcome.lastLine,
      contextTokens: outcome.contextTokens,
      lastModel: outcome.lastModel,
      pendingTurns: outcome.pending,
    };

    eventsParsed += outcome.events;
    filesProcessed += 1;
  }

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'qwenwork'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

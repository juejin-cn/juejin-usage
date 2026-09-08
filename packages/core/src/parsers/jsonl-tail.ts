/**
 * Byte-exact incremental reader for append-only JSONL logs.
 *
 * Parsers resume from a stored byte offset. Reading with readline and then
 * storing `stat().size` loses data: a scan that lands while an agent is
 * mid-write yields a truncated last "line" whose JSON.parse fails, yet the
 * cursor still jumps past those bytes, so the record is skipped forever once
 * the writer completes it. The same mismatch double-counts when the file grew
 * between stat and EOF.
 *
 * `readJsonlTail` instead reports the offset it actually consumed:
 * - lines terminated by `\n` are always committed;
 * - a trailing line without `\n` is only committed when it parses as JSON
 *   (a complete record whose newline has not landed yet, or a file the writer
 *   left unterminated); otherwise the cursor stops at its first byte so the
 *   next round re-reads it whole.
 */
import { createReadStream } from 'node:fs';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface JsonlTailResult {
  /** Byte offset just past the last committed line; store this as the cursor. */
  nextOffset: number;
  /** True when a trailing partial line was left for the next round. */
  pendingPartial: boolean;
}

export interface ReadJsonlTailOptions {
  /** Byte offset to resume from (default 0). */
  start?: number;
  /**
   * Called once per complete line, in file order. Blank lines are skipped.
   * Return `false` to stop reading; `nextOffset` then covers only the lines
   * handed over so far.
   */
  onLine: (line: string) => void | boolean;
  /**
   * Decides whether a trailing line that has no newline is a complete record.
   * Defaults to a JSON.parse probe.
   */
  isCompleteRecord?: (line: string) => boolean;
}

function looksLikeJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stream `filePath` from `start`, handing complete lines to `onLine`.
 *
 * Lines are split on raw bytes so multi-byte UTF-8 sequences that straddle
 * chunk boundaries decode correctly and offsets stay exact.
 */
export async function readJsonlTail(
  filePath: string,
  options: ReadJsonlTailOptions,
): Promise<JsonlTailResult> {
  const start = options.start ?? 0;
  const isComplete = options.isCompleteRecord ?? looksLikeJson;

  let carry: Buffer = Buffer.alloc(0);
  // Offset of carry[0] in the file; also the resume point for a partial line.
  let carryStart = start;
  let consumed = start;
  let stopped = false;

  const emit = (raw: Buffer): boolean => {
    let end = raw.length;
    if (end > 0 && raw[end - 1] === CARRIAGE_RETURN) end -= 1;
    if (end === 0) return true;
    const line = raw.subarray(0, end).toString('utf8');
    if (!line.trim()) return true;
    return options.onLine(line) !== false;
  };

  const stream = createReadStream(filePath, { start });
  try {
    for await (const chunk of stream) {
      carry = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);
      let searchFrom = 0;
      for (;;) {
        const idx = carry.indexOf(NEWLINE, searchFrom);
        if (idx === -1) break;
        const keepGoing = emit(carry.subarray(searchFrom, idx));
        searchFrom = idx + 1;
        consumed = carryStart + searchFrom;
        if (!keepGoing) {
          stopped = true;
          break;
        }
      }
      if (searchFrom > 0) {
        carry = carry.subarray(searchFrom);
        carryStart += searchFrom;
      }
      if (stopped) break;
    }
  } finally {
    stream.destroy();
  }

  if (stopped) {
    return { nextOffset: consumed, pendingPartial: false };
  }

  // Trailing bytes without a newline: commit only if they already form a
  // record, otherwise leave the cursor at their first byte.
  let trailing = carry;
  if (trailing.length > 0 && trailing[trailing.length - 1] === CARRIAGE_RETURN) {
    trailing = trailing.subarray(0, trailing.length - 1);
  }
  const tail = trailing.toString('utf8');
  if (!tail.trim()) {
    return { nextOffset: carryStart + carry.length, pendingPartial: false };
  }
  if (isComplete(tail)) {
    options.onLine(tail);
    return { nextOffset: carryStart + carry.length, pendingPartial: false };
  }
  return { nextOffset: carryStart, pendingPartial: true };
}

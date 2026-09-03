/**
 * DeepSeek Harness (dsh) passive reader — source dsh, collector dsh.
 *
 * 数据源：~/.dsh/sessions/<workspace>/<sessionId>/session.jsonl(.zstd)。
 * 每个文件是 JSONL（默认 zstd 压缩），逐行一个事件；token 用量只出现在
 * assistant/message 事件的 data.usage（每个 assistant 消息的最终值）。模型优先
 * 取 data.message.source，回退到 request/header；项目根目录在 session 首行的 cwd。
 *
 * 增量策略：zstd 无法按字节偏移续读，因此按「会话文件 inode+size+mtime 变了
 * 才重读」短路；重读时用 sessionId|messageId 去重，避免把已统计的消息重复计数。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

import type { CursorsFile, QueueBucket, TokenTotals } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketsFromState,
  type BucketAccumulator,
} from './shared.js';
import { diffGeminiTotals, sameGeminiTotals } from './gemini.js';

export const DSH_COLLECTOR = 'dsh';

const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_SEEN_MESSAGES = 50_000;

/** DSH 单个消息的去重快照（last-wins，与 opencode/zcode 对齐）。 */
type DshMessageTotals = Omit<TokenTotals, 'conversation_count'>;

interface DshSessionCursor {
  inode: number;
  size: number;
  mtimeMs: number;
  project: string;
}

interface DshCursors {
  files: Record<string, DshSessionCursor>;
  messages: Record<string, { lastTotals: DshMessageTotals }>;
}

/** DSH 数据目录（$DSH_HOME 或 ~/.dsh）。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_HOME?.trim();
  if (explicit) {
    return explicit.startsWith('~') ? join(homedir(), explicit.slice(1)) : explicit;
  }
  return join(homedir(), '.dsh');
}

/** DSH 会话根目录（workspace 目录的父目录）。 */
function dshSessionsDir(home = dshHome()): string {
  return join(home, 'sessions');
}

/** 收集所有会话文件（按路径排序，稳定）。 */
export function listDshSessionFiles(home = dshHome()): string[] {
  const sessionsDir = dshSessionsDir(home);
  const results: string[] = [];

  let workspaces: string[];
  try {
    workspaces = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(sessionsDir, e.name))
      .sort();
  } catch {
    return results;
  }

  for (const ws of workspaces) {
    try {
      const entries = readdirSync(ws, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const compressedFile = join(ws, entry.name, 'session.jsonl.zstd');
        const plainFile = join(ws, entry.name, 'session.jsonl');
        if (existsSync(compressedFile)) results.push(compressedFile);
        else if (existsSync(plainFile)) results.push(plainFile);
      }
    } catch {
      // 跳过不可读的 workspace 目录
    }
  }
  return results;
}

/** 解析 JSONL 首行的 cwd。 */
function readSessionCwd(text: string): string | null {
  const newline = text.indexOf('\n');
  const firstLine = newline >= 0 ? text.slice(0, newline) : text;
  if (!firstLine.includes('"cwd"')) return null;
  try {
    const obj = JSON.parse(firstLine) as { cwd?: unknown };
    return typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim() : null;
  } catch {
    return null;
  }
}

/** 解压单帧 zstd，返回 (解压内容, 消费的压缩字节数)。 */
function zstdDecompressFrame(compressed: Buffer): { out: Buffer; consumed: number } | null {
  try {
    const res = zlib.zstdDecompressSync(compressed, { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: number };
    };
    const consumed = res.engine?.bytesWritten ?? 0;
    if (!consumed || consumed <= 0) return null;
    return { out: res.buffer, consumed };
  } catch {
    return null;
  }
}

/**
 * 解压 DSH 会话文件 → UTF-8 文本。
 *
 * DSH 的 session.jsonl.zstd 是流式追加写入的「多帧」zstd 文件，Node 内置的
 * zstdDecompressSync 只解压第一个帧。这里按帧循环解压并拼接：每次用
 * { info: true } 拿到 engine.bytesWritten（本帧消费的压缩字节数）推进偏移，
 * 直到覆盖整个 buffer。
 */
function decodeDsh(compressed: Buffer): string | null {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('zstdDecompressSync unavailable (Node >= 22.9 with zstd support required)');
  }
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  // 防御性上限，避免损坏文件导致死循环。
  const guard = compressed.length + 1;
  let frames = 0;
  while (offset < compressed.length && frames < guard) {
    const frame = zstdDecompressFrame(compressed.subarray(offset));
    if (!frame) {
      // 首帧就失败 → 整个文件损坏；中途失败 → 已解压部分仍可用。
      if (frames === 0) return null;
      break;
    }
    chunks.push(frame.out);
    total += frame.out.length;
    if (total > MAX_DECODED_BYTES) {
      throw new Error(`decoded session exceeds ${MAX_DECODED_BYTES} bytes`);
    }
    offset += frame.consumed;
    frames += 1;
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString('utf8');
}

function coerceEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }
  return null;
}

function toNonNeg(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function capMessages(messages: Record<string, { lastTotals: DshMessageTotals }>): void {
  const keys = Object.keys(messages);
  if (keys.length <= MAX_SEEN_MESSAGES) return;
  for (const k of keys.slice(0, keys.length - MAX_SEEN_MESSAGES)) {
    delete messages[k];
  }
}

export interface ParseDshResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseDshIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseDshResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const dshRoot = (cursors as CursorsFile & { dsh?: DshCursors }).dsh;
  if (!dshRoot) {
    (cursors as CursorsFile & { dsh: DshCursors }).dsh = { files: {}, messages: {} };
  }
  const dsh = (cursors as CursorsFile & { dsh: DshCursors }).dsh;
  if (!dsh.files) dsh.files = {};
  if (!dsh.messages) dsh.messages = {};

  const bucketState: BucketAccumulator = new Map();
  const files = listDshSessionFiles();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of files) {
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    const prev = dsh.files[filePath];
    const unchanged =
      prev && prev.inode === st.ino && prev.size === st.size && prev.mtimeMs === st.mtimeMs;
    if (unchanged) {
      filesProcessed += 1;
      continue;
    }

    // 文件有变化：全量读取并逐行解析，靠 message 去重只计增量。
    let contents: Buffer;
    try {
      contents = readFileSync(filePath);
    } catch {
      continue;
    }
    let text: string | null;
    try {
      text = filePath.endsWith('.zstd') ? decodeDsh(contents) : contents.toString('utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/zstdDecompressSync unavailable/i.test(msg)) {
        return {
          result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: msg },
          cursors,
        };
      }
      continue;
    }
    if (!text) {
      // 解码失败（写入中的文件）—— 保留旧游标，下次重试。
      continue;
    }

    let project = prev?.project;
    if (!project) {
      const cwd = readSessionCwd(text);
      project = cwd ? resolveProjectName(cwd) : 'unknown';
    }

    let requestModel = 'unknown';
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (!line.includes('"usage"') && !line.includes('"request/header"')) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.type === 'request/header') {
        const data = obj.data as Record<string, unknown> | undefined;
        const header = data?.header as Record<string, unknown> | undefined;
        const config = header?.config as Record<string, unknown> | undefined;
        if (typeof config?.model === 'string' && config.model.trim()) {
          requestModel = config.model.trim();
        }
        continue;
      }
      if (obj.type !== 'assistant/message') continue;

      const data = obj.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object') continue;
      const usage = data.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== 'object') continue;

      const message = data.message as Record<string, unknown> | undefined;
      const source = (message?.source as Record<string, unknown> | undefined) ?? {};
      const model = typeof source.model === 'string' && source.model.trim()
        ? source.model.trim()
        : requestModel;
      const msgId = typeof message?.id === 'string' && message.id ? message.id : null;

      const input = toNonNeg(usage.inputTokens);
      const output = toNonNeg(usage.outputTokens);
      const cacheRead = toNonNeg(usage.cacheReadTokens);
      const cacheWrite = toNonNeg(usage.cacheWriteTokens);
      const totals: DshMessageTotals = {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        reasoning_output_tokens: 0,
        total_tokens: input + output + cacheRead + cacheWrite,
      };
      if (totals.total_tokens === 0) continue;

      const tsMs = coerceEpochMs(obj.time);
      if (!tsMs) continue;
      const hourStart = toUtcHalfHourStart(new Date(tsMs).toISOString());
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      const key = `${filePath}|${msgId ?? line.slice(0, 64)}`;
      const prevTotals = dsh.messages[key]?.lastTotals;
      const tokenDelta = diffGeminiTotals(totals, prevTotals);
      if (!sameGeminiTotals(totals, prevTotals)) {
        dsh.messages[key] = { lastTotals: totals };
      }
      if (!tokenDelta) continue;

      // 文件变化时会重扫历史消息；只计新消息或同一消息增长的 token 差值。
      const delta: TokenTotals = {
        ...tokenDelta,
        conversation_count: prevTotals ? 0 : 1,
      };
      accumulateBucket(bucketState, 'dsh', model, project, hourStart, delta, DSH_COLLECTOR);
      eventsParsed += 1;
    }

    dsh.files[filePath] = { inode: st.ino, size: st.size, mtimeMs: st.mtimeMs, project };
    filesProcessed += 1;
  }

  capMessages(dsh.messages);

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'dsh'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}

/**
 * TeleAgent passive reader (source `teleagent`).
 *
 * TeleAgent（中电信星辰超级智能体）在本地数据目录下按天写入
 * `super-agent-server-*.log`。每次模型调用都会打印一条 `[cost]` 行：
 *
 *   2026/09/21 09:49:46.820855 processor.go:806: [Info]
 *     [request_id:01a0c1a7-...] [cost] provider=NewApi tokens(in=33651 out=113 cacheRead=2048) cost=$0.000000
 *
 * 同一 request_id 的模型名来自更早的 GetModelCapabilities 行：
 *
 *   ... [Registry] GetModelCapabilities provider="NewApi" model="chat-pro" capabilities={...
 *
 * 本 parser 按文件字节游标增量读取日志，解析 `[cost]` 行把 token 用量按半小时
 * 聚合到 queue。TeleAgent 采用积分（quota）计费，日志中 cost 恒为 $0，因此
 * 不计费用。
 *
 * 路径覆盖：
 *   - AI_USAGE_TELEAGENT_LOGS — 自定义日志根目录（默认 ~/.local/share/TeleAgent/users）
 */
import { existsSync, readdirSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export const TELEAGENT_COLLECTOR = 'teleagent';

/** Max request_id → model entries kept across sync rounds. */
const MAX_LAST_MODELS = 500;
/** Max dedup keys retained in cursors. */
const MAX_SEEN_HASHES = 50_000;

type TeleagentExtCursors = CursorsFile & {
  teleagent?: {
    files?: Record<
      string,
      { inode: number; size: number; mtimeMs: number; offset: number }
    >;
    seenHashes?: string[];
    lastModels?: Record<string, string>;
  };
};

/** TeleAgent 本地数据根目录（`~/.local/share/TeleAgent/users`）。 */
export function teleagentLogsRoot(): string {
  const env = process.env.AI_USAGE_TELEAGENT_LOGS?.trim();
  if (env) return env;
  return join(homedir(), '.local', 'share', 'TeleAgent', 'users');
}

function walkLogFiles(dir: string, depth: number, out: string[]): void {
  if (depth > 4 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      // 只下探到 <users>/<userId>/log 层级，避免深入整个数据目录
      walkLogFiles(full, depth + 1, out);
    } else if (/^super-agent-server-.+\.log$/.test(ent.name)) {
      out.push(full);
    }
  }
}

/** 递归发现所有 `super-agent-server-*.log` 日志文件。 */
export function findTeleagentLogFiles(): string[] {
  const out: string[] = [];
  walkLogFiles(teleagentLogsRoot(), 0, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** `2026/09/21 09:49:46.820855`（本地时间）→ epoch ms。 */
function parseLogTime(line: string): number | null {
  const m =
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)/.exec(line);
  if (!m) return null;
  const ms = Number((m[7]! + '000').slice(0, 3));
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    ms,
  );
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function extractRequestId(line: string): string | null {
  const m = /\[request_id:([0-9a-fA-F-]+)\]/.exec(line);
  return m ? m[1] : null;
}

function extractModel(line: string): string | null {
  // ... [Registry] GetModelCapabilities provider="NewApi" model="chat-pro" ...
  const m = /GetModelCapabilities provider="[^"]+" model="([^"]+)"/.exec(line);
  return m ? m[1] : null;
}

const COST_LINE_RE =
  /\[cost\] provider=\S+\s+tokens\(in=(\d+)\s+out=(\d+)\s+cacheRead=(\d+)\)\s+cost=\$\S+/;

function nonNeg(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 解析一条 `[cost]` 行，返回 token 增量；非 cost 行返回 null。 */
function parseCostLine(line: string): Omit<TokenTotals, 'conversation_count'> | null {
  const m = COST_LINE_RE.exec(line);
  if (!m) return null;
  const input = nonNeg(m[1]!);
  const output = nonNeg(m[2]!);
  const cacheRead = nonNeg(m[3]!);
  const delta = {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const total = computeTotalTokens(delta);
  if (total === 0) return null;
  return { ...delta, total_tokens: total };
}

export interface ParseTeleagentResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

export async function parseTeleagentIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseTeleagentResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const ext = cursors as TeleagentExtCursors;
  if (!ext.teleagent) {
    ext.teleagent = { files: {}, seenHashes: [], lastModels: {} };
  }
  const fileCursors = ext.teleagent.files ?? (ext.teleagent.files = {});
  const seenHashes = new Set(ext.teleagent.seenHashes ?? []);
  const lastModels = new Map(Object.entries(ext.teleagent.lastModels ?? {}));
  const bucketState: BucketAccumulator = new Map();

  let eventsParsed = 0;
  let filesProcessed = 0;

  for (const filePath of findTeleagentLogFiles()) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) continue;

    const prev = fileCursors[filePath];
    const inode = st.ino;
    const sameInode = prev && prev.inode === inode;
    const truncated = sameInode && (prev.offset ?? 0) > st.size;
    const startOffset = sameInode && !truncated ? (prev.offset ?? 0) : 0;
    if (sameInode && !truncated && startOffset >= st.size) continue;

    const stream = createReadStream(filePath, { start: startOffset });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let fileOffset = startOffset;
    for await (const raw of rl) {
      const line = raw;
      const lineStart = fileOffset;
      fileOffset += Buffer.byteLength(line, 'utf8') + 1;

      if (!line.trim()) continue;

      // 模型行：记录 request_id → model
      const model = extractModel(line);
      const requestId = extractRequestId(line);
      if (model && requestId) {
        lastModels.set(requestId, model);
        if (lastModels.size > MAX_LAST_MODELS) {
          const first = lastModels.keys().next().value;
          if (first !== undefined) lastModels.delete(first);
        }
      }

      if (!line.includes('[cost]')) continue;
      const delta = parseCostLine(line);
      if (!delta) continue;

      const ts = parseLogTime(line);
      if (ts == null) continue;
      const hourStart = toUtcHalfHourStart(new Date(ts).toISOString());
      if (!hourStart) continue;
      if (new Date(hourStart).getTime() < sinceMs) continue;

      // 去重：同一行内容不会重复入账
      const dedup = createHash('sha256')
        .update(`${filePath}|${lineStart}|${line}`)
        .digest('hex');
      if (seenHashes.has(dedup)) continue;
      seenHashes.add(dedup);

      const modelName =
        (requestId ? lastModels.get(requestId) : undefined) ?? 'unknown';
      accumulateBucket(
        bucketState,
        'teleagent',
        modelName,
        'unknown',
        hourStart,
        { ...delta, conversation_count: 1 },
        TELEAGENT_COLLECTOR,
      );
      eventsParsed += 1;
    }

    fileCursors[filePath] = {
      inode,
      size: st.size,
      mtimeMs: st.mtimeMs,
      offset: fileOffset,
    };
    filesProcessed += 1;
  }

  ext.teleagent.seenHashes = Array.from(seenHashes).slice(-MAX_SEEN_HASHES);
  ext.teleagent.lastModels = Object.fromEntries(lastModels);

  return {
    result: {
      buckets: bucketsFromState(bucketState, 'teleagent'),
      eventsParsed,
      filesProcessed,
    },
    cursors,
  };
}
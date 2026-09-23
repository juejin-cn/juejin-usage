/**
 * KinetAios passive reader — source `kinetaios`, collector `kinetaios`.
 *
 * 数据源：KinetAios（开源本地 AI agent 桌面端，github.com/phinn/KinetAiosWin）的
 * 用户数据目录下的 `history.db`（SQLite，WAL 模式）。每次 LLM 回合完成时写入一行
 * `cost_log`（tokens_in / tokens_out / amount USD / ts ms），模型名在
 * `conversations.model`，项目目录在 `conversations.cwd`。
 *
 * 目录定位（跨平台）：
 *   macOS   ~/Library/Application Support/KinetAios/history.db
 *   Windows %APPDATA%/KinetAios/history.db
 *   Linux   $XDG_CONFIG_HOME/KinetAios/history.db
 * 覆盖顺序：`AI_USAGE_KINETAIOS_DB` > 上述默认。Electron 侧 userData 目录名钉死为
 * `KinetAios`（不随 productName/brand.json 变化），故默认路径是稳定的。
 *
 * 增量策略：`cost_log.id` 是每行唯一主键（uuid），cursor 记录已见 id 的最近窗口 +
 * 已处理行的 max(ts)。查询按 `ts > max(lastTs, statsSince)` 过滤后用 seenIds 去重
 * 兜底同毫秒写入。单价（amount）是 KinetAios 按 profile 价格表算出的真实美元成本，
 * 聚到 bucket 上走 `reported_cost_usd`（与 Cursor CSV 同通道），成本视图零估算误差。
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import type { CursorsFile, QueueBucket } from '../types.js';
import { resolveProjectName } from '../project-name.js';
import { toUtcHalfHourStart } from '../queue/keys.js';
import {
  accumulateBucket,
  bucketStateKey,
  bucketsFromState,
  type BucketAccumulator,
} from './shared.js';
import { queryDbJson, readSqliteWithSnapshot } from './sqlite.js';

export const KINETAIOS_COLLECTOR = 'kinetaios';

const MAX_SEEN_IDS = 50_000;

/** KinetAios history.db 路径（显式 env 覆盖优先）。 */
export function kinetaiosDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AI_USAGE_KINETAIOS_DB?.trim();
  if (explicit) {
    return explicit.startsWith('~') ? join(homedir(), explicit.slice(1)) : explicit;
  }
  if (platform() === 'win32') {
    const appData = env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'KinetAios', 'history.db');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'KinetAios', 'history.db');
  }
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(xdg, 'KinetAios', 'history.db');
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

interface KinetaiosCursors {
  /** 已消费 cost_log.id（滑动窗口，防同毫秒重复计数）。 */
  seenIds: string[];
  /** 已处理的最大 ts（ms）。下一轮只拉这之后的新行。 */
  lastTs: number;
}

export interface ParseKinetaiosResult {
  buckets: QueueBucket[];
  eventsParsed: number;
  filesProcessed: number;
  skipped?: boolean;
  error?: string;
}

// 单行 SQL：cost_log LEFT JOIN conversations 补模型名与项目目录（都是可空的）。
// 尾部 `${since}` 由 parseKinetaiosIncremental 内联填（数值字面量，无注入面）。
const COST_QUERY = `SELECT
    c.id,
    c.amount,
    c.tokens_in,
    c.tokens_out,
    c.ts,
    co.model,
    co.cwd
  FROM cost_log c
  LEFT JOIN conversations co ON co.id = c.conv_id
  WHERE c.ts > `;

export async function parseKinetaiosIncremental(
  cursors: CursorsFile,
  statsSince: string,
): Promise<{ result: ParseKinetaiosResult; cursors: CursorsFile }> {
  const sinceMs = new Date(statsSince).getTime();
  const holder = cursors as CursorsFile & { kinetaios?: KinetaiosCursors };
  if (!holder.kinetaios) {
    holder.kinetaios = { seenIds: [], lastTs: 0 };
  }
  const cur = holder.kinetaios;
  if (!Array.isArray(cur.seenIds)) cur.seenIds = [];
  if (!Number.isFinite(cur.lastTs)) cur.lastTs = 0;

  const seenIds = new Set(cur.seenIds);
  const bucketState: BucketAccumulator = new Map();
  const costByKey = new Map<string, number>();

  const dbPath = kinetaiosDbPath();
  if (!existsSync(dbPath)) {
    return {
      result: { buckets: [], eventsParsed: 0, filesProcessed: 0 },
      cursors,
    };
  }

  let eventsParsed = 0;
  let rows: Array<Record<string, unknown>>;
  try {
    // queryDbJson 不支持绑定参数(node:sqlite 直查 / sqlite3 -json CLI 双通道共用一条
    // SQL 字符串)→ ts 由本进程 cursor 计算后内联,数值字面量无注入面。
    const since = Math.max(cur.lastTs, sinceMs);
    const sql = `${COST_QUERY} ${since}`;
    rows = readSqliteWithSnapshot(dbPath, (snap) => queryDbJson(snap, sql));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/sqlite3 CLI not found/i.test(msg) || /no such table/i.test(msg)) {
      // 未装 KinetAios / 旧版本还没有 cost_log 表 → 静默跳过（与 kilo-cli 同策略）。
      return {
        result: { buckets: [], eventsParsed: 0, filesProcessed: 0, skipped: true, error: msg },
        cursors,
      };
    }
    throw err;
  }

  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : null;
    if (!id) continue;
    if (seenIds.has(id)) continue;

    const ts = toCount(row.ts);
    const tsIso = ts > 0 ? new Date(ts).toISOString() : null;
    const hourStart = tsIso ? toUtcHalfHourStart(tsIso) : null;
    if (!hourStart) continue;

    const input = toCount(row.tokens_in);
    const output = toCount(row.tokens_out);
    const total = input + output;
    if (total === 0) {
      seenIds.add(id); // 空行也记 seen，防止 cursor 推进后同批行被反复扫描
      continue;
    }

    const cwd = typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd : null;
    const project = cwd ? resolveProjectName(cwd) : 'unknown';
    const model = typeof row.model === 'string' && row.model ? row.model : 'unknown';
    accumulateBucket(
      bucketState,
      'kinetaios',
      model,
      project,
      hourStart,
      {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: total,
        conversation_count: 1,
      },
      KINETAIOS_COLLECTOR,
    );

    // KinetAios 自带按模型单价折算的真实成本 → reported-first 通道。
    const amount = Number(row.amount);
    if (Number.isFinite(amount) && amount > 0) {
      const key = bucketStateKey('kinetaios', model, project, hourStart, KINETAIOS_COLLECTOR);
      costByKey.set(key, (costByKey.get(key) ?? 0) + amount);
    }

    seenIds.add(id);
    eventsParsed += 1;
    if (ts > cur.lastTs) cur.lastTs = ts;
  }

  cur.seenIds = Array.from(seenIds).slice(-MAX_SEEN_IDS);

  // filesProcessed 语义沿用 sqlite reader 系（zcode/kilo-cli）：读过 1 个库记 1。
  return {
    result: {
      buckets: bucketsFromState(bucketState, 'kinetaios').map((bucket) => {
        const key = bucketStateKey(
          bucket.source,
          bucket.model,
          bucket.project,
          bucket.hour_start,
          KINETAIOS_COLLECTOR,
        );
        const reported = costByKey.get(key);
        return reported != null && reported > 0 ? { ...bucket, reported_cost_usd: reported } : bucket;
      }),
      eventsParsed,
      filesProcessed: rows.length > 0 ? 1 : 0,
    },
    cursors,
  };
}

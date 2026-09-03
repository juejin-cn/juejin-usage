import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

let nodeSqlite: { DatabaseSync?: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb } | null | undefined;

interface SqliteDb {
  prepare(sql: string): { all(): Record<string, unknown>[] };
  close(): void;
}

function getNodeSqlite() {
  if (nodeSqlite !== undefined) return nodeSqlite;
  try {
    const prevEmit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const opts = rest[0];
      const type = typeof opts === 'object' && opts ? (opts as { type?: string }).type : opts;
      const name = typeof warning === 'object' && warning ? warning.name : undefined;
      if ((type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && String(warning).includes('SQLite')) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (prevEmit as (...args: any[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      nodeSqlite = require('node:sqlite') as typeof nodeSqlite;
    } finally {
      process.emitWarning = prevEmit;
    }
  } catch {
    nodeSqlite = null;
  }
  return nodeSqlite;
}

function openNodeSqlite(dbPath: string): SqliteDb | null {
  const mod = getNodeSqlite();
  if (!mod?.DatabaseSync) return null;
  try {
    return new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    if (isSqliteLockError(err)) throw err;
    return null;
  }
}

function queryViaCli(
  dbPath: string,
  sql: string,
  { timeout = 30_000, maxBuffer = 100 * 1024 * 1024 }: { timeout?: number; maxBuffer?: number } = {},
): Record<string, unknown>[] {
  // Capture stderr so sqlite3 errors (e.g. missing tables) do not leak to the
  // parent console; callers already treat query failures as best-effort.
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf-8',
    maxBuffer,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const trimmed = out.trim();
  if (!trimmed || trimmed === '[]') return [];
  return JSON.parse(trimmed) as Record<string, unknown>[];
}

function dbFileStamp(dbPath: string): string {
  try {
    const st = statSync(dbPath);
    let wal = '0';
    try {
      const w = statSync(`${dbPath}-wal`);
      wal = `${w.mtimeMs}:${w.size}`;
    } catch {
      // no WAL
    }
    return `${st.mtimeMs}:${st.size}:${wal}`;
  } catch {
    return 'missing';
  }
}

const sqliteQueryCache = new Map<string, { stamp: string; rows: Record<string, unknown>[] }>();

/** Test seam. */
export function resetSqliteQueryCache(): void {
  sqliteQueryCache.clear();
}

export function queryDbJson(
  dbPath: string,
  sql: string,
  opts?: { timeout?: number; maxBuffer?: number },
): Record<string, unknown>[] {
  const stamp = dbFileStamp(dbPath);
  const key = `${dbPath}\n${sql}`;
  const hit = sqliteQueryCache.get(key);
  if (hit && hit.stamp === stamp && stamp !== 'missing') {
    return hit.rows;
  }

  const db = openNodeSqlite(dbPath);
  let rows: Record<string, unknown>[];
  if (db) {
    try {
      rows = db.prepare(sql).all();
    } finally {
      db.close();
    }
  } else {
    rows = queryViaCli(dbPath, sql, opts);
  }
  if (stamp !== 'missing') {
    sqliteQueryCache.set(key, { stamp, rows });
  }
  return rows;
}

export function isSqliteLockError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as NodeJS.ErrnoException;
  const msg = e.message ?? '';
  const code = e.code ?? '';
  if (code === 'EBUSY') return true;
  if (
    (code === 'EPERM' || code === 'EACCES') &&
    /copyfile|open|resource busy|locked|operation not permitted/i.test(msg)
  ) {
    return true;
  }
  return /database is locked|SQLITE_BUSY|resource busy or locked|being used by another process|unable to open database file/i.test(
    msg,
  );
}

/** Copying a multi-GB DB (e.g. Cursor's state.vscdb) to tmp would cause a huge IO/CPU spike. */
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export function readSqliteWithSnapshot<T>(
  dbPath: string,
  query: (snapshotPath: string) => T,
): T {
  try {
    return query(dbPath);
  } catch (err) {
    if (!isSqliteLockError(err)) throw err;
    let dbSize = Number.POSITIVE_INFINITY;
    try {
      dbSize = statSync(dbPath).size;
    } catch {
      // fall through: treat unstat-able DB as too big to snapshot
    }
    if (dbSize > MAX_SNAPSHOT_BYTES) throw err;
    const snapshotDir = mkdtempSync(join(tmpdir(), 'ai-usage-sqlite-'));
    const snapshotPath = join(snapshotDir, 'state.vscdb');
    try {
      copyFileSync(dbPath, snapshotPath);
      for (const suffix of ['-shm', '-wal']) {
        const companion = `${dbPath}${suffix}`;
        if (existsSync(companion)) copyFileSync(companion, `${snapshotPath}${suffix}`);
      }
      return query(snapshotPath);
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }
}

/** True when `table` exists in the SQLite database (best-effort; false on error). */
export function sqliteTableExists(dbPath: string, table: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return false;
  try {
    const rows = readSqliteWithSnapshot(dbPath, (snap) =>
      queryDbJson(
        snap,
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='${table}' LIMIT 1`,
      ),
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

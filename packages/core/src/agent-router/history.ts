import { mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RouterError } from './config.js';
import type { RouterTrace } from './gateway.js';

const MAX_BYTES = 8 * 1024 * 1024;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
interface Row { sequence: number; trace: RouterTrace }
export interface HistoryPage { requests: RouterTrace[]; next: number | null; cursor: string }
export interface HistoryDelta { requests: RouterTrace[]; cursor: string; hasMore: boolean; reset: boolean }
function cursor(row?: Row): string { return Buffer.from(JSON.stringify([row?.sequence ?? 0, row?.trace.id ?? null])).toString('base64url'); }
function anchor(value: string): [number, string | null] {
  try {
    if (!/^[\w-]{1,256}$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0 || (parsed[0] === 0 ? parsed[1] !== null : typeof parsed[1] !== 'string' || parsed[1].length > 80)) throw new Error();
    return parsed as [number, string | null];
  } catch { throw new RouterError('INVALID_HISTORY_CURSOR'); }
}
// Persist only explicit metadata, including when loading a locally edited file.
function trace(value: RouterTrace): RouterTrace {
  if (!value || typeof value.id !== 'string' || value.id.length > 80 || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) || !['completed', 'failed', 'cancelled'].includes(value.outcome) || !Array.isArray(value.attempts)) throw new Error('invalid trace');
  const pick = (object: object, keys: string[]) => Object.fromEntries(Object.entries(object).filter(([key, v]) => keys.includes(key) && (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 2048)));
  return { ...pick(value, ['id', 'startedAt', 'model', 'protocol', 'status', 'durationMs', 'outcome', 'affinity', 'phase', 'queuedMs', 'strategy', 'reason']),
    attempts: value.attempts.slice(0, 3).map(a => pick(a, ['target', 'status', 'durationMs', 'queuedMs', 'responseStartMs', 'committed', 'sent', 'failure', 'reason'])),
    decisions: Array.isArray(value.decisions) ? value.decisions.slice(0, 16).map(d => pick(d, ['target', 'eligible', 'reason', 'retryAt'])) : [],
  } as unknown as RouterTrace;
}
/** One owner (the desktop sidecar). Writes are serialized and never delay inference. */
export class RouterHistory {
  private pending = Promise.resolve();
  private queued = 0;
  private error: string | null = null;
  constructor(private directory: string, private now = Date.now) {}
  status() { return { error: this.error, pending: this.queued }; }
  private day(value: string): string {
    if (!datePattern.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new RouterError('INVALID_HISTORY_DATE');
    return value;
  }
  private async rows(day: string): Promise<Row[]> {
    let file;
    try { file = await open(join(this.directory, this.day(day) + '.json'), 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      if ((await file.stat()).size > MAX_BYTES) throw new Error('history too large');
      const parsed = JSON.parse(await file.readFile('utf8')) as Row[];
      if (!Array.isArray(parsed) || parsed.length > 1000) throw new Error('invalid history');
      let previous = 0;
      return parsed.map(row => {
        if (!Number.isSafeInteger(row.sequence) || row.sequence <= previous) throw new Error('invalid sequence');
        previous = row.sequence; return { sequence: row.sequence, trace: trace(row.trace) };
      });
    } finally { await file.close(); }
  }
  append(value: RouterTrace): void {
    if (this.queued >= 128) { this.error = 'HISTORY_QUEUE_FULL'; return; }
    let safe: RouterTrace;
    try { safe = trace(value); } catch { this.error = 'HISTORY_WRITE_FAILED'; return; }
    this.queued++;
    this.pending = this.pending.then(async () => {
      const day = new Date(safe.startedAt).toISOString().slice(0, 10);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const rows = await this.rows(day);
      rows.push({ sequence: (rows.at(-1)?.sequence ?? 0) + 1, trace: safe });
      if (rows.length > 1000) rows.splice(0, rows.length - 1000);
      let raw = JSON.stringify(rows);
      while (Buffer.byteLength(raw) > MAX_BYTES && rows.length > 1) { rows.shift(); raw = JSON.stringify(rows); }
      const destination = join(this.directory, day + '.json'); const temporary = destination + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); }
      finally { await unlink(temporary).catch(() => {}); }
      const cutoff = new Date(this.now() - 6 * 86400000).toISOString().slice(0, 10);
      for (const file of await readdir(this.directory)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(file) && file.slice(0, 10) < cutoff) await unlink(join(this.directory, file));
      this.error = null;
    }).catch(() => { this.error = 'HISTORY_WRITE_FAILED'; }).finally(() => { this.queued--; });
  }
  async dates(): Promise<string[]> {
    await this.pending;
    try { return (await readdir(this.directory)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().reverse(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new RouterError('HISTORY_READ_FAILED', 500); }
  }
  async page(day: string, before?: number): Promise<HistoryPage> {
    this.day(day);
    if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new RouterError('INVALID_HISTORY_CURSOR');
    await this.pending;
    try {
      const all = await this.rows(day);
      const rows = all.filter(row => before === undefined || row.sequence < before).reverse();
      const page = rows.slice(0, 50);
      return { cursor: cursor(all.at(-1)), requests: page.map(row => row.trace), next: rows.length > 50 ? page.at(-1)!.sequence : null };
    } catch { throw new RouterError('HISTORY_READ_FAILED', 500); }
  }
  async changes(day: string, after: string): Promise<HistoryDelta> {
    this.day(day); const [sequence, id] = anchor(after); await this.pending;
    try {
      const rows = await this.rows(day);
      // An evicted, deleted or replaced anchor must trigger a full reload, never silently skip records.
      const valid = sequence === 0 ? !rows.length || rows[0].sequence === 1 : rows.some(row => row.sequence === sequence && row.trace.id === id);
      if (!valid) return { requests: [], cursor: cursor(rows.at(-1)), hasMore: false, reset: true };
      const newer = rows.filter(row => row.sequence > sequence); const batch = newer.slice(0, 50);
      return { requests: batch.map(row => row.trace).reverse(), cursor: batch.length ? cursor(batch.at(-1)) : after, hasMore: newer.length > 50, reset: false };
    } catch { throw new RouterError('HISTORY_READ_FAILED', 500); }
  }
  async flush(): Promise<void> { await this.pending; }
}

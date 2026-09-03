import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, writeFile, appendFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import type { ManifestFile, QueueBucket } from '../types.js';
import { bucketKey, monthFromHourStart } from './keys.js';
import { manifestPath, queueDir } from '../paths.js';

async function visitJsonlFile(
  filePath: string,
  visitor: (row: QueueBucket) => void,
): Promise<void> {
  if (!existsSync(filePath)) return;
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      visitor(JSON.parse(line) as QueueBucket);
    } catch {
      // skip bad lines
    }
  }
}

export async function readJsonlFile(filePath: string): Promise<QueueBucket[]> {
  const rows: QueueBucket[] = [];
  await visitJsonlFile(filePath, (row) => rows.push(row));
  return rows;
}

export function dedupeBuckets(rows: QueueBucket[]): QueueBucket[] {
  const seen = new Map<string, QueueBucket>();
  for (const row of rows) {
    seen.set(bucketKey(row), row);
  }
  return Array.from(seen.values());
}

export function filterSince(rows: QueueBucket[], statsSince: string): QueueBucket[] {
  const since = new Date(statsSince).getTime();
  return rows.filter((r) => new Date(r.hour_start).getTime() >= since);
}

export async function listQueueMonths(dataDir: string): Promise<string[]> {
  const dir = queueDir(dataDir);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace('.jsonl', ''))
    .sort();
}

export async function loadBucketsForRange(
  dataDir: string,
  statsSince: string,
  months?: string[],
): Promise<QueueBucket[]> {
  const monthList = months ?? (await listQueueMonths(dataDir));
  const since = new Date(statsSince).getTime();
  const seen = new Map<string, QueueBucket>();
  for (const month of monthList) {
    await visitJsonlFile(
      join(queueDir(dataDir), `${month}.jsonl`),
      (row) => {
        if (new Date(row.hour_start).getTime() < since) return;
        seen.set(bucketKey(row), row);
      },
    );
  }
  return Array.from(seen.values());
}

export async function loadRecentBuckets(
  dataDir: string,
  statsSince: string,
): Promise<QueueBucket[]> {
  // Load every month from the collect floor through now (today/7D/30D/90D).
  return loadBucketsForRange(dataDir, statsSince);
}

export async function clearQueueBuckets(dataDir: string): Promise<void> {
  const dir = queueDir(dataDir);
  if (!existsSync(dir)) return;
  const entries = await readdir(dir);
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    await unlink(join(dir, name)).catch(() => undefined);
  }
  await rebuildManifest(dataDir);
}

export async function clearCursors(dataDir: string): Promise<void> {
  await writeFile(join(dataDir, 'cursors.json'), '{}\n', 'utf8');
  cursorsCache.set(dataDir, { value: {}, serialized: '{}' });
}

/** Reset incremental cursors + local queue so the next sync can re-collect. */
export async function resetLocalUsageCache(dataDir: string): Promise<void> {
  await clearCursors(dataDir);
  await clearQueueBuckets(dataDir);
}

export async function appendBuckets(
  dataDir: string,
  buckets: QueueBucket[],
): Promise<void> {
  if (buckets.length === 0) return;
  const byMonth = new Map<string, QueueBucket[]>();
  for (const b of buckets) {
    const month = monthFromHourStart(b.hour_start);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(b);
  }
  for (const [month, rows] of byMonth) {
    const file = join(queueDir(dataDir), `${month}.jsonl`);
    await mkdir(queueDir(dataDir), { recursive: true });
    const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await appendFile(file, lines, 'utf8');
  }
  await updateManifest(dataDir, Array.from(byMonth.keys()), byMonth);
}

/** Full rebuild — used after clear or when manifest is missing/corrupt. */
export async function rebuildManifest(dataDir: string): Promise<void> {
  const months = await listQueueMonths(dataDir);
  const files = [];
  for (const month of months) {
    const path = `queue/${month}.jsonl`;
    const rows = await readJsonlFile(join(dataDir, path));
    const deduped = dedupeBuckets(rows);
    let firstHour: string | null = null;
    let lastHour: string | null = null;
    for (const r of deduped) {
      if (!firstHour || r.hour_start < firstHour) firstHour = r.hour_start;
      if (!lastHour || r.hour_start > lastHour) lastHour = r.hour_start;
    }
    files.push({ month, path, firstHour, lastHour });
  }
  const activeMonth = months.at(-1) ?? monthFromHourStart(new Date().toISOString());
  const manifest: ManifestFile = { activeMonth, files };
  await writeFile(manifestPath(dataDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Incremental manifest update: only touch months that received appends.
 * Avoids re-reading every historical jsonl on each small write.
 */
async function updateManifest(
  dataDir: string,
  touchedMonths?: string[],
  appendedByMonth?: Map<string, QueueBucket[]>,
): Promise<void> {
  if (!touchedMonths || touchedMonths.length === 0) {
    await rebuildManifest(dataDir);
    return;
  }

  let existing: ManifestFile | null = null;
  const path = manifestPath(dataDir);
  if (existsSync(path)) {
    try {
      existing = JSON.parse(await readFile(path, 'utf8')) as ManifestFile;
    } catch {
      existing = null;
    }
  }
  if (!existing?.files) {
    await rebuildManifest(dataDir);
    return;
  }

  const byMonth = new Map(existing.files.map((f) => [f.month, { ...f }]));
  for (const month of touchedMonths) {
    const prev = byMonth.get(month) ?? {
      month,
      path: `queue/${month}.jsonl`,
      firstHour: null as string | null,
      lastHour: null as string | null,
    };
    const appended = appendedByMonth?.get(month) ?? [];
    for (const row of appended) {
      if (!prev.firstHour || row.hour_start < prev.firstHour) {
        prev.firstHour = row.hour_start;
      }
      if (!prev.lastHour || row.hour_start > prev.lastHour) {
        prev.lastHour = row.hour_start;
      }
    }
    // If month file exists but we have no prior bounds, sample from append only
    // (already done). Do not re-read the full jsonl.
    byMonth.set(month, prev);
  }

  const files = Array.from(byMonth.values()).sort((a, b) =>
    a.month.localeCompare(b.month),
  );
  const months = files.map((f) => f.month);
  const activeMonth =
    months.at(-1) ?? monthFromHourStart(new Date().toISOString());
  const manifest: ManifestFile = { activeMonth, files };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

interface CursorsCacheEntry {
  value: import('../types.js').CursorsFile;
  serialized: string;
}

const cursorsCache = new Map<string, CursorsCacheEntry>();

/** Test seam: drop the in-memory cursors cache (does not touch disk). */
export function resetCursorsCache(dataDir?: string): void {
  if (dataDir) cursorsCache.delete(dataDir);
  else cursorsCache.clear();
}

export async function loadCursors(dataDir: string): Promise<import('../types.js').CursorsFile> {
  const hit = cursorsCache.get(dataDir);
  if (hit) return hit.value;

  const path = join(dataDir, 'cursors.json');
  if (!existsSync(path)) {
    const empty = {};
    cursorsCache.set(dataDir, { value: empty, serialized: '{}' });
    return empty;
  }
  try {
    const raw = await readFile(path, 'utf8');
    const value = JSON.parse(raw) as import('../types.js').CursorsFile;
    cursorsCache.set(dataDir, { value, serialized: raw.trim() });
    return value;
  } catch {
    const empty = {};
    cursorsCache.set(dataDir, { value: empty, serialized: '{}' });
    return empty;
  }
}

export async function saveCursors(dataDir: string, cursors: import('../types.js').CursorsFile): Promise<void> {
  // Compact form: this file is rewritten after every sync and can be large
  // (dedup hashes); pretty-printing roughly doubles the serialize/write cost.
  const json = JSON.stringify(cursors);
  const hit = cursorsCache.get(dataDir);
  if (hit && hit.serialized === json) {
    hit.value = cursors;
    return;
  }
  await writeFile(join(dataDir, 'cursors.json'), `${json}\n`, 'utf8');
  cursorsCache.set(dataDir, { value: cursors, serialized: json });
}

/** True when a sync round changed parser cursors and they must be persisted. */
export function syncMutatedCursors(
  results: Array<{ skipped?: boolean; filesProcessed: number; bucketsWritten: number }>,
): boolean {
  return results.some(
    (r) => !r.skipped && (r.filesProcessed > 0 || r.bucketsWritten > 0),
  );
}

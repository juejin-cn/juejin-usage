import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { lock } from 'proper-lockfile';

import type { TudConfig } from './types.js';
import { configPath, resolveDataDir, syncLogPath } from './paths.js';
import { appendJsonLog } from './debug-log.js';
import { clearCursors } from './queue/index.js';
import {
  BAKED_PRICING_TTL_MS,
  BAKED_PRICING_URL,
} from './pricing/baked-defaults.js';

/** Production public API root (no trailing slash). Same semantics as VITE_API_BASE. */
export const DEFAULT_JUEJIN_API_URL = 'https://api.juejin.cn/aiusage_api';

/** Default upload / collect floor when `statsSince` is first seeded. */
export const DEFAULT_STATS_SINCE_DAYS = 90;

/** Dashboard local range chips (今天 / 7D / 30D / 90D). */
export const LOCAL_RANGE_DAYS = [1, 7, 30, 90] as const;
export type LocalRangeDays = (typeof LOCAL_RANGE_DAYS)[number];

/** Old defaults / origins → rewrite to DEFAULT_JUEJIN_API_URL on load. */
const LEGACY_DEFAULT_API_URLS = new Set([
  'http://127.0.0.1:8787',
  'http://localhost:8787',
  'https://token-usage.sugarat.top',
  'https://token-usage.sugarat.top/api',
]);

export function daysAgoIso(days: number, nowMs = Date.now()): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/** Local collect/display floor; falls back to upload `statsSince`. */
export function resolveLocalCollectSince(config: TudConfig): string {
  const local = config.localCollectSince?.trim();
  if (local) return local;
  return config.statsSince?.trim() || '';
}

export function isLocalRangeDays(days: number): days is LocalRangeDays {
  return (LOCAL_RANGE_DAYS as readonly number[]).includes(days);
}

/**
 * Move upload / collect floors earlier to cover `daysAgo` (default 90).
 * Never moves a floor later. Returns whether collect floor expanded.
 */
export function alignLookbackFloors(
  config: TudConfig,
  opts?: { daysAgo?: number; nowMs?: number },
): { changed: boolean; collectExpanded: boolean } {
  const daysAgo =
    opts?.daysAgo != null && opts.daysAgo > 0
      ? opts.daysAgo
      : DEFAULT_STATS_SINCE_DAYS;
  const desired = daysAgoIso(daysAgo, opts?.nowMs);
  const desiredMs = Date.parse(desired);
  let changed = false;
  let collectExpanded = false;

  const statsMs = Date.parse(config.statsSince ?? '');
  if (!Number.isFinite(statsMs) || statsMs > desiredMs) {
    config.statsSince = desired;
    changed = true;
  }

  const collectMs = Date.parse(resolveLocalCollectSince(config));
  if (!Number.isFinite(collectMs) || collectMs > desiredMs) {
    config.localCollectSince = desired;
    changed = true;
    collectExpanded = true;
  }

  return { changed, collectExpanded };
}

export function bakedPricingConfig(): NonNullable<TudConfig['pricing']> {
  return {
    url: BAKED_PRICING_URL,
    ttlMs: BAKED_PRICING_TTL_MS,
  };
}

/**
 * Align `config.pricing` to package bake. Missing or different → overwrite.
 * Returns whether pricing was mutated.
 */
export function ensurePricingAligned(config: TudConfig): boolean {
  const desired = bakedPricingConfig();
  const cur = config.pricing;
  const curTtl =
    cur?.ttlMs != null && Number.isFinite(cur.ttlMs) && cur.ttlMs > 0
      ? cur.ttlMs
      : BAKED_PRICING_TTL_MS;
  if (
    cur == null ||
    (cur.url ?? '') !== desired.url ||
    curTtl !== desired.ttlMs
  ) {
    config.pricing = desired;
    return true;
  }
  return false;
}

export async function ensureDataDir(dataDir?: string): Promise<string> {
  const dir = resolveDataDir(dataDir);
  await mkdir(dir, { recursive: true });
  await mkdir(`${dir}/queue`, { recursive: true });
  await mkdir(`${dir}/bin`, { recursive: true });
  await mkdir(`${dir}/logs`, { recursive: true });
  return dir;
}

function defaultConfig(dir: string): TudConfig {
  const deviceId = randomUUID();
  return {
    deviceId,
    // Filled by touchStatsSince on start/sync (supports hidden --days debug seed).
    statsSince: '',
    hostname: hostname(),
    dataDir: dir,
    juejin: {
      enabled: true,
      apiUrl: DEFAULT_JUEJIN_API_URL,
      authMode: 'tbd',
      // Upload identity is an opaque `jau.` token from 掘金登录. Until linked,
      // reuse deviceId as a local placeholder (upload skips when unlinked).
      token: deviceId,
    },
    pricing: bakedPricingConfig(),
    serverPort: 8452,
    lastSyncAt: null,
  };
}

/**
 * Linked upload identity (`jau.` token). `token === deviceId` is the
 * unlinked placeholder and must not be used for cloud ingest / UI as linked.
 */
export function resolveLinkedUserId(
  deviceId: string,
  token: string | null | undefined,
): string | null {
  const trimmed = token?.trim() || null;
  if (!trimmed) return null;
  if (trimmed === deviceId.trim()) return null;
  return trimmed;
}

/**
 * Ensure deviceId / production cloud defaults / pricing bake exist.
 * Returns whether config was mutated.
 */
export function ensureIdentity(config: TudConfig): {
  changed: boolean;
  deviceIdCreated: boolean;
} {
  let changed = false;
  let deviceIdCreated = false;

  if (!config.deviceId?.trim()) {
    config.deviceId = randomUUID();
    deviceIdCreated = true;
    changed = true;
  }

  if (!config.juejin) {
    config.juejin = {
      enabled: true,
      apiUrl: DEFAULT_JUEJIN_API_URL,
      authMode: 'tbd',
      token: config.deviceId,
    };
    changed = true;
  } else {
    const apiUrl = config.juejin.apiUrl?.trim() ?? '';
    if (!apiUrl || LEGACY_DEFAULT_API_URLS.has(apiUrl.replace(/\/+$/, ''))) {
      config.juejin.apiUrl = DEFAULT_JUEJIN_API_URL;
      changed = true;
    }

    if (!config.juejin.token?.trim()) {
      config.juejin.token = config.deviceId;
      changed = true;
    }
  }

  if (ensurePricingAligned(config)) {
    changed = true;
  }

  return { changed, deviceIdCreated };
}

export function salvageIdentityFromCorruptConfig(raw: string): {
  deviceId?: string;
  token?: string;
} {
  const deviceId = /"deviceId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i.exec(
    raw,
  )?.[1];
  const token = /"token"\s*:\s*"(jau\.[^"]+)"/.exec(raw)?.[1];
  return {
    ...(deviceId ? { deviceId } : {}),
    ...(token ? { token } : {}),
  };
}

export interface CorruptConfigRecovery {
  backupPath: string;
  tokenSalvaged: boolean;
  deviceIdSalvaged: boolean;
}

export interface LoadConfigResult {
  dir: string;
  config: TudConfig;
  recoveredFromCorrupt?: CorruptConfigRecovery;
}

async function recoverCorruptConfig(
  dir: string,
  path: string,
  raw: string,
): Promise<LoadConfigResult> {
  const backupPath = `${path}.bak.${Date.now()}`;
  try {
    await rename(path, backupPath);
  } catch {
    // If rename fails, still try to overwrite with a valid config.
  }
  const salvaged = salvageIdentityFromCorruptConfig(raw);
  const config = defaultConfig(dir);
  if (salvaged.deviceId) {
    config.deviceId = salvaged.deviceId;
    if (!salvaged.token) {
      config.juejin.token = salvaged.deviceId;
    }
  }
  if (salvaged.token) {
    config.juejin.token = salvaged.token;
  }
  ensureIdentity(config);
  await writeConfigUnlocked(dir, config);
  const recovery: CorruptConfigRecovery = {
    backupPath,
    tokenSalvaged: Boolean(salvaged.token),
    deviceIdSalvaged: Boolean(salvaged.deviceId),
  };
  await appendJsonLog(syncLogPath(dir), {
    event: 'config_recovered_from_corrupt',
    backupPath,
    tokenSalvaged: recovery.tokenSalvaged,
    deviceIdSalvaged: recovery.deviceIdSalvaged,
  });
  return { dir, config, recoveredFromCorrupt: recovery };
}

export async function loadConfig(dataDir?: string): Promise<LoadConfigResult> {
  const dir = await ensureDataDir(dataDir);
  return withConfigLock(dir, () => loadConfigUnlocked(dir));
}

/** Caller holds the config lock, including initialization and migration writes. */
async function loadConfigUnlocked(dir: string): Promise<LoadConfigResult> {
  const path = configPath(dir);
  if (!existsSync(path)) {
    const config = defaultConfig(dir);
    await writeConfigUnlocked(dir, config);
    return { dir, config };
  }
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return recoverCorruptConfig(dir, path, raw);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return recoverCorruptConfig(dir, path, raw);
  }
  const config = parsed as TudConfig;
  config.dataDir = dir;
  const { changed } = ensureIdentity(config);
  if (changed) {
    await writeConfigUnlocked(dir, config);
  }
  return { dir, config };
}

export async function saveConfig(dir: string, config: TudConfig): Promise<void> {
  await withConfigLock(dir, async () => {
    const persisted = await readPersistedConfig(dir);
    const next = { ...config };
    // A settings snapshot may predate a completed background sync/upload.
    // These fields belong to the runtime, not to the settings writer.
    for (const field of ['lastSyncAt', 'lastUploadAt'] as const) {
      if (persisted?.[field]) {
        next[field] = latestTimestamp(persisted[field], config[field]);
      }
    }
    await writeConfigUnlocked(dir, next);
    for (const field of ['lastSyncAt', 'lastUploadAt'] as const) {
      if (field in next) config[field] = next[field];
    }
  });
}

async function withConfigLock<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  // Both the main process and sync worker must use the same lock. It also
  // covers a config that does not exist yet, and recovers locks left by crashes.
  const release = await lock(configPath(dir), {
    realpath: false,
    stale: 10_000,
    update: 5_000,
    retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 200 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readPersistedConfig(dir: string): Promise<TudConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(dir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid config: expected an object');
  }
  return parsed as TudConfig;
}

async function writeConfigUnlocked(dir: string, config: TudConfig): Promise<void> {
  const path = configPath(dir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const mode = await stat(path).then((info) => info.mode & 0o777).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return 0o600;
    throw error;
  });
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function latestTimestamp(
  persisted: string | null | undefined,
  proposed: string | null | undefined,
): string | null | undefined {
  const persistedMs = Date.parse(persisted ?? '');
  const proposedMs = Date.parse(proposed ?? '');
  return Number.isFinite(persistedMs) &&
    (!Number.isFinite(proposedMs) || persistedMs > proposedMs)
    ? persisted : proposed;
}

export async function touchStatsSince(
  dir: string,
  config: TudConfig,
  opts?: { daysAgo?: number },
): Promise<TudConfig> {
  let changed = false;
  let collectExpanded = false;
  if (!config.statsSince?.trim()) {
    const daysAgo =
      opts?.daysAgo != null && opts.daysAgo > 0
        ? opts.daysAgo
        : DEFAULT_STATS_SINCE_DAYS;
    config.statsSince = daysAgoIso(daysAgo);
    changed = true;
  }
  // Seed local collect floor once; later dashboard expands may move it earlier.
  if (!config.localCollectSince?.trim()) {
    config.localCollectSince = config.statsSince;
    changed = true;
  }
  // Existing installs: only expand toward 90d. Hidden `--days` skips this so
  // debug seeds are not immediately overwritten.
  if (opts?.daysAgo == null) {
    const aligned = alignLookbackFloors(config);
    changed = changed || aligned.changed;
    collectExpanded = aligned.collectExpanded;
  }
  if (changed) {
    await saveConfig(dir, config);
  }
  if (collectExpanded) {
    await clearCursors(dir);
  }
  return config;
}

export async function setLastSyncAt(dir: string, config: TudConfig): Promise<void> {
  await setRuntimeTimestamp(dir, config, 'lastSyncAt');
}

export async function setLastUploadAt(dir: string, config: TudConfig): Promise<void> {
  await setRuntimeTimestamp(dir, config, 'lastUploadAt');
}

async function setRuntimeTimestamp(
  dir: string,
  config: TudConfig,
  field: 'lastSyncAt' | 'lastUploadAt',
): Promise<void> {
  const completedAt = new Date().toISOString();
  await withConfigLock(dir, async () => {
    // Parsers/uploaders hold old snapshots across awaits. Never write their
    // settings back just to record completion of background work.
    const persisted = await readPersistedConfig(dir) ?? { ...config };
    persisted[field] = latestTimestamp(persisted[field], completedAt);
    await writeConfigUnlocked(dir, persisted);
    config[field] = persisted[field];
  });
}

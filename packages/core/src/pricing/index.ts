import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { QueueBucket } from '../types.js';
import { pricingOverlayPath } from '../paths.js';
import pricingData from './pricing.json' with { type: 'json' };
import {
  BAKED_PRICING_TTL_MS,
  BAKED_PRICING_URL,
} from './baked-defaults.js';
import {
  hasNonZeroPricing,
  lookupPricingStacked,
  type ModelPricingRates,
  type PricingData,
} from './matcher.js';

export type ModelPricing = Required<{
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}>;

export type { ModelPricingRates, PricingData };
export { lookupPricing, lookupPricingStacked, hasNonZeroPricing } from './matcher.js';
export { BAKED_PRICING_URL, BAKED_PRICING_TTL_MS } from './baked-defaults.js';

const ZERO_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
};

/** Bundled full table — never mutated at runtime. */
const builtinPricing = pricingData as PricingData;

/** Optional remote partial overlay (exact/alias/fuzzy/default). */
let remoteOverlay: PricingData | null = null;

let pricingRefreshUrl: string | null = null;
let pricingUpdatedAt: string | null = null;
let pricingRefreshTimer: ReturnType<typeof setInterval> | null = null;
let pricingRefreshInFlight: Promise<boolean> | null = null;
/** Last applied overlay JSON; skip onUpdate/rebuild when the remote body is identical. */
let lastOverlayFingerprint: string | null = null;

function overlayFingerprint(data: PricingData): string {
  return JSON.stringify(data);
}

export const DEFAULT_PRICING_TTL_MS = 3_600_000;
/** Desktop / CLI wait this long for the first overlay fetch before opening. */
export const DEFAULT_PRICING_FIRST_FETCH_TIMEOUT_MS = 3_000;

export interface PricingStatus {
  hasOverlay: boolean;
  url: string | null;
  updatedAt: string | null;
}

export interface StartPricingRefreshOptions {
  url: string;
  /** @deprecated Overlay is fetched once at startup; no periodic refresh. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  onUpdate?: (status: PricingStatus) => void;
  onError?: (err: unknown) => void;
  /** Persist overlay under this data dir (`pricing-overlay.json`). */
  dataDir?: string;
  /**
   * Wait for the first network fetch up to this many ms.
   * 0 (default) keeps the old fire-and-forget behavior.
   */
  firstFetchTimeoutMs?: number;
}

/** Stop function; `.ready` settles after the optional first-fetch wait. */
export type PricingRefreshHandle = (() => void) & {
  ready: Promise<boolean>;
};

function toModelPricing(rates: ModelPricingRates | null): ModelPricing {
  return {
    input: rates?.input ?? 0,
    output: rates?.output ?? 0,
    cache_read: rates?.cache_read ?? 0,
    cache_write: rates?.cache_write ?? 0,
  };
}

function isFiniteNonNeg(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function validateRates(rates: unknown, path: string): string | null {
  if (rates == null || typeof rates !== 'object' || Array.isArray(rates)) {
    return `${path} must be an object`;
  }
  const o = rates as Record<string, unknown>;
  for (const key of ['input', 'output', 'cache_read', 'cache_write'] as const) {
    if (o[key] === undefined) continue;
    if (!isFiniteNonNeg(o[key])) {
      return `${path}.${key} must be a finite number >= 0`;
    }
  }
  return null;
}

/**
 * Structural validation for remote overlay JSON.
 * `exact` may be `{}`; pure alias/default overlays are allowed.
 */
export function validatePricingData(raw: unknown): { ok: true; data: PricingData } | { ok: false; error: string } {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'pricing JSON must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  let exact: Record<string, ModelPricingRates> = {};
  if (obj.exact !== undefined) {
    if (obj.exact == null || typeof obj.exact !== 'object' || Array.isArray(obj.exact)) {
      return { ok: false, error: 'exact must be an object' };
    }
    exact = {};
    for (const [key, rates] of Object.entries(obj.exact as Record<string, unknown>)) {
      const err = validateRates(rates, `exact.${key}`);
      if (err) return { ok: false, error: err };
      exact[key] = rates as ModelPricingRates;
    }
  }

  let alias: Record<string, string> | undefined;
  if (obj.alias !== undefined) {
    if (obj.alias == null || typeof obj.alias !== 'object' || Array.isArray(obj.alias)) {
      return { ok: false, error: 'alias must be an object' };
    }
    alias = {};
    for (const [k, v] of Object.entries(obj.alias as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v.trim()) {
        return { ok: false, error: `alias.${k} must be a non-empty string` };
      }
      alias[k] = v;
    }
  }

  let fuzzy: Array<{ match: string; ref: string }> | undefined;
  if (obj.fuzzy !== undefined) {
    if (!Array.isArray(obj.fuzzy)) {
      return { ok: false, error: 'fuzzy must be an array' };
    }
    fuzzy = [];
    for (let i = 0; i < obj.fuzzy.length; i++) {
      const row = obj.fuzzy[i];
      if (row == null || typeof row !== 'object' || Array.isArray(row)) {
        return { ok: false, error: `fuzzy[${i}] must be an object` };
      }
      const match = (row as { match?: unknown }).match;
      const ref = (row as { ref?: unknown }).ref;
      if (typeof match !== 'string' || !match || typeof ref !== 'string' || !ref) {
        return { ok: false, error: `fuzzy[${i}] needs non-empty match and ref strings` };
      }
      fuzzy.push({ match, ref });
    }
  }

  let sourceAlias: Record<string, Record<string, string>> | undefined;
  if (obj.sourceAlias !== undefined) {
    if (obj.sourceAlias == null || typeof obj.sourceAlias !== 'object' || Array.isArray(obj.sourceAlias)) {
      return { ok: false, error: 'sourceAlias must be an object' };
    }
    sourceAlias = {};
    for (const [src, map] of Object.entries(obj.sourceAlias as Record<string, unknown>)) {
      if (map == null || typeof map !== 'object' || Array.isArray(map)) {
        return { ok: false, error: `sourceAlias.${src} must be an object` };
      }
      const inner: Record<string, string> = {};
      for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
        if (typeof v !== 'string' || !v.trim()) {
          return { ok: false, error: `sourceAlias.${src}.${k} must be a non-empty string` };
        }
        inner[k] = v;
      }
      sourceAlias[src] = inner;
    }
  }

  let defaultRates: ModelPricingRates | undefined;
  if (obj.default !== undefined) {
    const err = validateRates(obj.default, 'default');
    if (err) return { ok: false, error: err };
    defaultRates = obj.default as ModelPricingRates;
  }

  const data: PricingData = { exact };
  if (obj._meta != null && typeof obj._meta === 'object' && !Array.isArray(obj._meta)) {
    data._meta = obj._meta as Record<string, unknown>;
  }
  if (alias) data.alias = alias;
  if (fuzzy) data.fuzzy = fuzzy;
  if (sourceAlias) data.sourceAlias = sourceAlias;
  if (defaultRates) data.default = defaultRates;

  return { ok: true, data };
}

/** Replace (or clear) the in-memory remote overlay. Does not touch builtin. */
export function applyRemotePricingOverlay(data: PricingData | null): void {
  remoteOverlay = data;
  lastOverlayFingerprint = data ? overlayFingerprint(data) : null;
  pricingUpdatedAt = data ? new Date().toISOString() : null;
}

/** Load a previously saved overlay from `dataDir`. Invalid/missing files are ignored. */
export function loadCachedPricingOverlay(dataDir: string): boolean {
  try {
    const raw = readFileSync(pricingOverlayPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const validated = validatePricingData(parsed);
    if (!validated.ok) return false;
    applyRemotePricingOverlay(validated.data);
    return true;
  } catch {
    return false;
  }
}

/** Persist the current overlay so the next cold start can apply it synchronously. */
export async function saveCachedPricingOverlay(
  dataDir: string,
  data: PricingData,
): Promise<void> {
  await writeFile(pricingOverlayPath(dataDir), `${JSON.stringify(data)}\n`, 'utf8');
}

export function getPricingStatus(): PricingStatus {
  return {
    hasOverlay: remoteOverlay != null,
    url: pricingRefreshUrl,
    updatedAt: pricingUpdatedAt,
  };
}

/**
 * Current validated remote overlay, if one has been loaded.
 *
 * The public API publishes a remote pricing overlay to clients.
 * Callers must treat the returned object as read-only.
 */
export function getRemotePricingOverlay(): PricingData | null {
  return remoteOverlay;
}

/** Test helper: clear overlay and stop any refresh timer. */
export function resetPricingRuntime(): void {
  if (pricingRefreshTimer) {
    clearInterval(pricingRefreshTimer);
    pricingRefreshTimer = null;
  }
  remoteOverlay = null;
  pricingRefreshUrl = null;
  pricingUpdatedAt = null;
  pricingRefreshInFlight = null;
  lastOverlayFingerprint = null;
}

async function fetchAndApplyOverlay(
  url: string,
  fetchImpl: typeof fetch,
  dataDir?: string,
): Promise<boolean> {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`pricing fetch HTTP ${res.status}`);
  }
  const raw: unknown = await res.json();
  const validated = validatePricingData(raw);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  const fingerprint = overlayFingerprint(validated.data);
  if (fingerprint === lastOverlayFingerprint) {
    return false;
  }
  applyRemotePricingOverlay(validated.data);
  if (dataDir) {
    try {
      await saveCachedPricingOverlay(dataDir, validated.data);
    } catch {
      // Overlay is in memory; a disk write failure must not drop the fetch.
    }
  }
  return true;
}

/**
 * Fetch the remote pricing overlay once at startup. No periodic refresh —
 * the next process start loads the disk cache then pulls again.
 * Failures keep the previous overlay (or builtin-only). Never throws to caller.
 * Returns a stop() function; `ready` waits for the optional first-fetch timeout.
 */
export function startPricingRefresh(
  opts: StartPricingRefreshOptions,
): PricingRefreshHandle {
  const url = opts.url.trim();
  if (!url) {
    const noop = (() => {}) as PricingRefreshHandle;
    noop.ready = Promise.resolve(false);
    return noop;
  }

  if (pricingRefreshTimer) {
    clearInterval(pricingRefreshTimer);
    pricingRefreshTimer = null;
  }

  if (opts.dataDir) {
    loadCachedPricingOverlay(opts.dataDir);
  }

  pricingRefreshUrl = url;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const firstFetchTimeoutMs =
    opts.firstFetchTimeoutMs != null &&
    Number.isFinite(opts.firstFetchTimeoutMs) &&
    opts.firstFetchTimeoutMs > 0
      ? opts.firstFetchTimeoutMs
      : 0;

  const run = (): Promise<boolean> => {
    if (pricingRefreshInFlight) return pricingRefreshInFlight;
    pricingRefreshInFlight = (async () => {
      try {
        const changed = await fetchAndApplyOverlay(url, fetchImpl, opts.dataDir);
        if (changed) opts.onUpdate?.(getPricingStatus());
        return true;
      } catch (err) {
        opts.onError?.(err);
        return false;
      } finally {
        pricingRefreshInFlight = null;
      }
    })();
    return pricingRefreshInFlight;
  };

  const first = run();
  const ready =
    firstFetchTimeoutMs > 0
      ? Promise.race([
          first,
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), firstFetchTimeoutMs);
          }),
        ])
      : Promise.resolve(getPricingStatus().hasOverlay);

  const stop = (() => {
    if (pricingRefreshTimer) {
      clearInterval(pricingRefreshTimer);
      pricingRefreshTimer = null;
    }
  }) as PricingRefreshHandle;
  stop.ready = ready;
  return stop;
}

/**
 * Resolve pricing URL/TTL from env + config + package bake.
 * Env overrides for the process only (does not rewrite config).
 * Empty strings are treated as unset.
 */
export function resolvePricingRefreshConfig(opts?: {
  url?: string | null;
  ttlMs?: number | null;
}): { url: string | null; ttlMs: number } {
  const envUrl = process.env.TUD_PRICING_URL?.trim() || process.env.PRICING_URL?.trim() || '';
  const configUrl = opts?.url?.trim() || '';
  const bakedUrl = BAKED_PRICING_URL.trim();
  const url = envUrl || configUrl || bakedUrl || null;

  const envTtlRaw = process.env.TUD_PRICING_TTL_MS?.trim() || process.env.PRICING_TTL_MS?.trim();
  let ttlMs = BAKED_PRICING_TTL_MS > 0 ? BAKED_PRICING_TTL_MS : DEFAULT_PRICING_TTL_MS;
  if (envTtlRaw) {
    const n = Number.parseInt(envTtlRaw, 10);
    if (Number.isFinite(n) && n > 0) ttlMs = n;
  } else if (opts?.ttlMs != null && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) {
    ttlMs = opts.ttlMs;
  }

  return { url, ttlMs };
}

export function getModelPricing(model: string, opts?: { source?: string }): ModelPricing {
  const result = lookupPricingStacked(
    model,
    remoteOverlay,
    builtinPricing,
    opts?.source ?? null,
  );
  return toModelPricing(result.value);
}

export function isModelPriced(model: string, source?: string): boolean {
  const result = lookupPricingStacked(model, remoteOverlay, builtinPricing, source ?? null);
  return hasNonZeroPricing(result.value);
}

/** Match server/API cost precision: keep 8 decimals until UI rounds to cents. */
export function roundCostUsd(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export function computeRowCost(row: QueueBucket): number {
  if (
    row.source === 'cursor' &&
    row.reported_cost_usd != null &&
    Number.isFinite(row.reported_cost_usd) &&
    row.reported_cost_usd > 0
  ) {
    return row.reported_cost_usd;
  }

  const pricing = getModelPricing(row.model, { source: row.source });
  const reasoningIncludedInOutput = row.source === 'codex' || row.source === 'every-code';
  const reasoningCost = reasoningIncludedInOutput
    ? 0
    : (row.reasoning_output_tokens || 0) * pricing.output;

  return (
    ((row.input_tokens || 0) * pricing.input +
      (row.output_tokens || 0) * pricing.output +
      (row.cached_input_tokens || 0) * pricing.cache_read +
      (row.cache_creation_input_tokens || 0) * pricing.cache_write +
      reasoningCost) /
    1_000_000
  );
}

export function computeTokens(row: QueueBucket): number {
  return row.total_tokens;
}

export { ZERO_PRICING };

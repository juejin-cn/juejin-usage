import { LEADERBOARD_DEFAULT_LIMIT } from '@juejin-opensource/jusage-core/leaderboard';
import type { PricingData } from '@juejin-opensource/jusage-core';
import type {
  LeaderboardMetric,
  LeaderboardOverviewResponse,
  LeaderboardRange,
  LeaderboardResponse,
} from '@juejin-opensource/jusage-core';

export type {
  LeaderboardBoard,
  LeaderboardMetric,
  LeaderboardOverviewResponse,
  LeaderboardRange,
  LeaderboardResponse,
  LeaderboardRow,
  LeaderboardUserProfile,
  ToolLeaderboard,
} from '@juejin-opensource/jusage-core';

export interface LeaderboardFilterOptions {
  tools: Array<{ key: string; displayName: string }>;
  models: Array<{ tool: string; model: string }>;
}

export interface LeaderboardFilters {
  tool?: string;
  model?: string;
}

export interface ModelUsageRow {
  model: string;
  tokens: number;
  costUsd: number;
  pct: number;
}

/**
 * Unified response envelope used by both the cloud API and the
 * CLI local-api (8452):
 *
 *   { success: true,  message: 'ok',        data: T }
 *   { success: false, message: 'CODE_NAME', data: null }
 *
 * `request<T>` enforces this contract at the fetch boundary:
 *   - non-2xx HTTP      → throw `Error('NAME ${status}')`
 *   - 2xx but `success=false` → throw `Error(message)` (server-side code)
 *   - 2xx and `success=true`  → return `data` (the inner payload, not the envelope)
 *
 * Callers always work with the unwrapped `data` shape (e.g. `UsageSummary`
 * directly), so they never have to walk `.data.xxx` and never see `null`
 * where an object was expected.
 */
interface Envelope<T> {
  success: boolean;
  message: string;
  data: T | null;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    // Non-JSON body (e.g. plain "404 Not Found" from a missed proxy).
    throw new Error(`${init?.method ?? 'GET'} ${input} → ${res.status}`);
  }
  if (!res.ok || !body || body.success !== true || body.data === null) {
    const code = body?.message ?? `HTTP ${res.status}`;
    throw new Error(code);
  }
  return body.data;
}

export interface SourceUsageRow {
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
  models: ModelUsageRow[];
}

export interface UsageSummary {
  totalTokens: number;
  totalCostUsd: number;
  todayTokens: number;
  todayCostUsd: number;
  statsSince: string;
  bySource: SourceUsageRow[];
}

export interface DailyProjectUsage {
  project: string;
  tokens: number;
  models: Record<string, number>;
}

export interface DailyUsageRow {
  date: string;
  tokens: number;
  costUsd: number;
  models: Record<string, number>;
  projects?: DailyProjectUsage[];
}

export interface DailyUsageResponse {
  days: DailyUsageRow[];
}

export interface HourlyUsageRow {
  date: string;
  hour: number;
  /** Tool / integration channel (e.g. `claude`, `cursor`). */
  source: string;
  tokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface HourlyUsageResponse {
  hours: HourlyUsageRow[];
  timeZone: string;
}

export interface ModelBreakdownRow {
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
}

export interface ProjectModelBreakdownRow {
  model: string;
  source: string;
  tokens: number;
  costUsd: number;
  pct: number;
}

export interface ProjectBreakdownRow {
  project: string;
  tokens: number;
  costUsd: number;
  pct: number;
  models?: ProjectModelBreakdownRow[];
}

export interface ModelBreakdownResponse {
  models: ModelBreakdownRow[];
  projects: ProjectBreakdownRow[];
}

export interface PricingCatalogRow {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricingCatalogResponse {
  units: string;
  generatedAt: string | null;
  updatedAt: string | null;
  models: PricingCatalogRow[];
}

export interface UsageDataset {
  summary: UsageSummary;
  dailyRows: DailyUsageRow[];
  hourlyRows: HourlyUsageRow[];
  modelRows: ModelBreakdownRow[];
  projectRows: ProjectBreakdownRow[];
  syncStatus: SyncStatus | null;
}

export interface SyncStatus {
  lastSyncAt: string | null;
  lastUploadAt?: string | null;
  /** Server ingest floor; present on cloud sync-status. */
  ingestMinOccurredAt?: string | null;
  statsSince: string;
  juejinEnabled?: boolean;
  sources: Record<
    string,
    {
      status: string;
      hook: string;
      syncMode: string;
      message?: string;
    }
  >;
}

export interface TudConfigView {
  deviceId: string;
  statsSince: string;
  localCollectSince?: string;
  lastSyncAt: string | null;
  lastUploadAt: string | null;
  juejin: {
    enabled: boolean;
    apiUrl: string;
    authMode: string;
    /** True when any upload token is set (includes deviceId unlinked placeholder). */
    hasToken: boolean;
    /** Linked opaque `jau.` token; null when unset or still deviceId placeholder. */
    userId: string | null;
    /** Plain Juejin id for Settings display only. */
    originUserId: string | null;
    userName: string | null;
    avatarLarge: string | null;
  };
}

export interface TudConfigUpdate {
  juejin?: {
    enabled?: boolean;
    apiUrl?: string;
    token?: string | null;
    originUserId?: string | null;
    userName?: string | null;
    avatarLarge?: string | null;
  };
}

const API_BEARER_STORAGE_KEY = 'tud.apiBearer';

/**
 * CLI local-api (embedded or `VITE_API_TARGET=cli`) vs 掘金 Server
 * (`VITE_API_TARGET=server`). Built CLI bundles omit the env var → CLI.
 */
export function isCliBackend(): boolean {
  return import.meta.env.VITE_API_TARGET !== 'server';
}

/**
 * Public API root for server mode.
 * Empty → same-origin `/api` (gateway / 同域反代).
 *
 * Production builds set this to `https://api.juejin.cn/aiusage_api` so the
 * gateway forwards it without a path rewrite.
 */
function apiBase(): string {
  return (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/$/, '');
}

/**
 * Path prefix for function endpoints.
 * - CLI local-api hosts routes at `/functions/tud-*` (no `/api` mount).
 * - Server mode uses `${apiBase()}/functions/tud-*` (default `/api/functions/tud-`).
 */
function functionsPrefix(): string {
  if (isCliBackend()) return '/functions/tud-';
  const base = apiBase();
  return base ? `${base}/functions/tud-` : '/api/functions/tud-';
}

/**
 * CLI local-api and the cloud server share the same endpoint names.
 * `VITE_API_TARGET=server` flips the path prefix to the public API root.
 */
function apiPrefixes(): { summary: string; others: string } {
  const prefix = functionsPrefix();
  return {
    summary: `${prefix}account-usage-summary`,
    others: prefix,
  };
}

/** Bearer for Server API: localStorage override, then dev env fallback. */
export function getApiBearer(): string | null {
  try {
    const stored = localStorage.getItem(API_BEARER_STORAGE_KEY)?.trim();
    if (stored) return stored;
  } catch {
    // SSR / private mode
  }
  const fromEnv = import.meta.env.VITE_API_BEARER?.trim();
  return fromEnv || null;
}

export function setApiBearer(token: string | null): void {
  try {
    if (token?.trim()) {
      localStorage.setItem(API_BEARER_STORAGE_KEY, token.trim());
    } else {
      localStorage.removeItem(API_BEARER_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export function hasConfiguredApiBearer(): boolean {
  return Boolean(getApiBearer());
}

/**
 * Build headers for a Server-bound fetch.
 * Server mode sends `x-user-id` (from Settings / user/get / `VITE_API_BEARER`).
 * Does not send `Authorization: Bearer` (Web uses x-user-id only).
 * CLI mock mode keeps empty headers.
 */
function authHeaders(): Record<string, string> {
  if (isCliBackend()) return {};
  const userId = getApiBearer();
  if (!userId) return {};
  return { 'x-user-id': userId };
}

export async function fetchSummary(): Promise<UsageSummary> {
  const { summary } = apiPrefixes();
  return request<UsageSummary>(summary, { headers: authHeaders() });
}

export async function fetchDaily(days = 90): Promise<DailyUsageResponse> {
  const { others } = apiPrefixes();
  return request<DailyUsageResponse>(`${others}usage-daily?days=${days}`, {
    headers: authHeaders(),
  });
}

export async function fetchHourly(days = 1): Promise<HourlyUsageResponse> {
  const { others } = apiPrefixes();
  return request<HourlyUsageResponse>(`${others}usage-hourly?days=${days}`, {
    headers: authHeaders(),
  });
}

export async function fetchModelBreakdown(days = 30): Promise<ModelBreakdownResponse> {
  const { others } = apiPrefixes();
  return request<ModelBreakdownResponse>(
    `${others}usage-model-breakdown?days=${days}`,
    { headers: authHeaders() },
  );
}

const PRICING_CATALOG_URL =
  'https://api.juejin.cn/aiusage_api/functions/tud-pricing';

/**
 * Load the pricing data directly from the existing public pricing function.
 * The endpoint returns the raw PricingData object rather than the dashboard's
 * usual success/data envelope, so normalize it at this boundary.
 */
export async function fetchPricingCatalog(): Promise<PricingCatalogResponse> {
  const res = await fetch(PRICING_CATALOG_URL, {
    headers: authHeaders(),
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw new Error(`GET ${PRICING_CATALOG_URL} → ${res.status}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const pricingData = parsePricingData(body);
  return pricingDataToCatalog(pricingData, res.headers.get('last-modified'));
}

function parsePricingData(raw: unknown): PricingData {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('模型价格数据格式错误：响应必须是对象');
  }

  const exact = (raw as { exact?: unknown }).exact;
  if (exact === null || typeof exact !== 'object' || Array.isArray(exact)) {
    throw new Error('模型价格数据格式错误：exact 必须是对象');
  }

  for (const [model, value] of Object.entries(exact)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`模型价格数据格式错误：exact.${model} 必须是对象`);
    }
    for (const key of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const rate = (value as Record<string, unknown>)[key];
      if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) {
        throw new Error(`模型价格数据格式错误：exact.${model}.${key} 必须是非负数字`);
      }
    }
  }

  return raw as PricingData;
}

function pricingDataToCatalog(
  data: PricingData,
  updatedAt: string | null,
): PricingCatalogResponse {
  return {
    units: 'usd_per_million_tokens',
    generatedAt: null,
    updatedAt,
    models: Object.entries(data.exact)
      .map(([model, rates]) => ({
        model,
        input: rates.input ?? 0,
        output: rates.output ?? 0,
        cacheRead: rates.cache_read ?? 0,
        cacheWrite: rates.cache_write ?? 0,
      }))
      .sort((a, b) => a.model.localeCompare(b.model)),
  };
}

export async function fetchLeaderboard(
  days: number,
  metric: LeaderboardMetric,
  limit = LEADERBOARD_DEFAULT_LIMIT,
): Promise<LeaderboardResponse> {
  const { others } = apiPrefixes();
  const query = new URLSearchParams({
    days: String(days),
    limit: String(limit),
    metric,
  });
  return request<LeaderboardResponse>(
    `${others}leaderboard?${query.toString()}`,
    { headers: authHeaders() },
  );
}

export async function fetchLeaderboardOverview(
  range: LeaderboardRange,
  limit = LEADERBOARD_DEFAULT_LIMIT,
  filters: LeaderboardFilters = {},
): Promise<LeaderboardOverviewResponse> {
  const { others } = apiPrefixes();
  const query = new URLSearchParams({
    range,
    limit: String(limit),
  });
  if (filters.tool) query.set('tool', filters.tool);
  if (filters.model) query.set('model', filters.model);
  return request<LeaderboardOverviewResponse>(
    `${others}leaderboard-overview?${query.toString()}`,
    { headers: authHeaders() },
  );
}

export interface LeaderboardPreference {
  hideFromLeaderboard: boolean;
}

export async function fetchLeaderboardPreference(): Promise<LeaderboardPreference> {
  const { others } = apiPrefixes();
  return request<LeaderboardPreference>(`${others}leaderboard-preference`, {
    headers: authHeaders(),
  });
}

export async function updateLeaderboardPreference(
  hideFromLeaderboard: boolean,
): Promise<LeaderboardPreference> {
  const { others } = apiPrefixes();
  return request<LeaderboardPreference>(`${others}leaderboard-preference`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ hideFromLeaderboard }),
  });
}

export async function fetchSyncStatus(): Promise<SyncStatus> {
  const { others } = apiPrefixes();
  return request<SyncStatus>(`${others}sync-status`, { headers: authHeaders() });
}

/** Hook / upload watermark for CLI and desktop. Cloud Web does not use it. */
function fetchSyncStatusIfCli(): Promise<SyncStatus | null> {
  if (!isCliBackend()) return Promise.resolve(null);
  return fetchSyncStatus().catch(() => null);
}

/** Split windows so heatmap can keep long daily history while tool/model
 *  breakdown follows the selected dashboard range. */
export type UsageDatasetFetchDays =
  | number
  | {
      dailyDays: number;
      breakdownDays: number;
      hourlyDays?: number;
    };

function normalizeUsageDatasetDays(days: UsageDatasetFetchDays): {
  dailyDays: number;
  breakdownDays: number;
  hourlyDays: number;
} {
  if (typeof days === 'number') {
    return { dailyDays: days, breakdownDays: days, hourlyDays: days };
  }
  return {
    dailyDays: days.dailyDays,
    breakdownDays: days.breakdownDays,
    hourlyDays: days.hourlyDays ?? days.breakdownDays,
  };
}

/**
 * Shared read model for both the root usage page and the visual Dashboard.
 * Keeping the parallel request and envelope normalization here prevents the
 * two routes from drifting into subtly different loading behavior.
 *
 * Pass a number to use the same window for daily + breakdown (legacy usage
 * page). Pass `{ dailyDays, breakdownDays, hourlyDays }` when the activity
 * heatmap needs a longer daily lookback than the selected tool/model range.
 */
export async function fetchUsageDataset(
  days: UsageDatasetFetchDays,
): Promise<UsageDataset> {
  const { dailyDays, breakdownDays, hourlyDays } =
    normalizeUsageDatasetDays(days);
  const [summary, syncStatus, daily, hourly, models] = await Promise.all([
    fetchSummary(),
    fetchSyncStatusIfCli(),
    fetchDaily(dailyDays),
    fetchHourly(hourlyDays).catch(() => ({
      hours: [],
      timeZone: 'Asia/Shanghai',
    })),
    fetchModelBreakdown(breakdownDays),
  ]);

  return {
    summary,
    syncStatus,
    dailyRows: daily.days ?? [],
    hourlyRows: hourly.hours ?? [],
    modelRows: (models.models ?? []).filter((row) => row.tokens > 0),
    projectRows: (models.projects ?? []).filter((row) => row.tokens > 0),
  };
}

/** Thin refetch when daily/hourly cache already covers the heatmap window. */
export async function fetchUsageDatasetThin(
  previous: UsageDataset,
  breakdownDays: number,
  hourlyDays: number,
): Promise<UsageDataset> {
  const [summary, syncStatus, hourly, models] = await Promise.all([
    fetchSummary(),
    fetchSyncStatusIfCli(),
    fetchHourly(hourlyDays).catch(() => ({
      hours: [],
      timeZone: 'Asia/Shanghai',
    })),
    fetchModelBreakdown(breakdownDays),
  ]);

  return {
    summary,
    syncStatus: syncStatus ?? previous.syncStatus,
    dailyRows: previous.dailyRows,
    hourlyRows: hourly.hours ?? [],
    modelRows: (models.models ?? []).filter((row) => row.tokens > 0),
    projectRows: (models.projects ?? []).filter((row) => row.tokens > 0),
  };
}

export interface TriggerSyncResult {
  ok: boolean;
  results: unknown[];
  message: string;
}

export async function triggerSync(): Promise<TriggerSyncResult> {
  const { others } = apiPrefixes();
  return request<TriggerSyncResult>(`${others}trigger-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: '{}',
  });
}

export interface EnsureLocalRangeResult {
  expanded: boolean;
  localCollectSince: string;
  statsSince: string;
  sync: { ok: boolean; results: unknown[] } | null;
  message: string;
}

/** Expand local collect floor for today/7D/30D/90D and re-sync when needed. */
export async function ensureLocalRange(
  days: number,
): Promise<EnsureLocalRangeResult> {
  const { others } = apiPrefixes();
  return request<EnsureLocalRangeResult>(`${others}ensure-local-range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ days }),
  });
}

export async function fetchConfig(): Promise<TudConfigView> {
  const { others } = apiPrefixes();
  return request<TudConfigView>(`${others}config`, { headers: authHeaders() });
}

export type InstallGuideReason = 'new_user' | 'uninstalled' | 'active';

export interface InstallGuideResponse {
  shouldShowGuide: boolean;
  reason: InstallGuideReason;
  firstEventAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  daysSinceLastEvent: number | null;
}

/**
 * Server-only: ask the cloud whether the current user should see the
 * installation guide page. Only callable in Server mode (`!isCliBackend()`).
 * The CLI / desktop runs do not have this endpoint.
 */
export async function fetchInstallGuide(): Promise<InstallGuideResponse> {
  if (isCliBackend()) {
    throw new Error('INSTALL_GUIDE_SERVER_ONLY');
  }
  const { others } = apiPrefixes();
  return request<InstallGuideResponse>(`${others}install-guide`, {
    headers: authHeaders(),
  });
}

export async function saveConfig(update: TudConfigUpdate): Promise<TudConfigView> {
  const { others } = apiPrefixes();
  return request<TudConfigView>(`${others}config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(update),
  });
}

export interface JuejinProfileSyncResponse {
  changed: boolean;
  config: TudConfigView;
}

/** Pull the public Juejin user card into the local login snapshot. */
export async function refreshJuejinProfile(
  opts?: { force?: boolean },
): Promise<JuejinProfileSyncResponse> {
  const { others } = apiPrefixes();
  return request<JuejinProfileSyncResponse>(`${others}refresh-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ force: Boolean(opts?.force) }),
  });
}

/** User-facing hint for load/sync failures (CLI vs server dev). */
export function apiErrorHint(message: string): string | null {
  const lower = message.toLowerCase();
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    message.includes('→ 404') ||
    message.includes('→ 503')
  ) {
    return '请先运行 pnpm start，或确认 API 服务已启动。';
  }
  if (lower.includes('unauthorized') || message.includes('401')) {
    return isCliBackend()
      ? null
      : '请在「设置」中配置鉴权 Token，或检查 Token 是否有效。';
  }
  return null;
}

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

export const LOCAL_RUNTIME_RECOVERING_HINT = '本地服务正在恢复，请稍候';
const LOCAL_RUNTIME_RETRY_MS = 20_000;
const LOCAL_RUNTIME_RETRY_GAP_MS = 500;

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const envelope = await transportRequest<T>(input, init);
  if (!envelope || envelope.success !== true || envelope.data === null) {
    const code = envelope?.message ?? 'REQUEST_FAILED';
    throw new Error(
      code === 'LOCAL_RUNTIME_NOT_READY' ? LOCAL_RUNTIME_RECOVERING_HINT : code,
    );
  }
  return envelope.data;
}

function hasDesktopApi(): boolean {
  return typeof window !== 'undefined' && typeof window.tud?.api?.request === 'function';
}

function isRuntimeNotReadyBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return (body as { message?: unknown }).message === 'LOCAL_RUNTIME_NOT_READY';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefer in-process Core IPC in Electron; fall back to HTTP fetch elsewhere. */
async function transportRequest<T>(
  input: string,
  init?: RequestInit,
): Promise<Envelope<T> | null> {
  if (hasDesktopApi()) {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body != null
          ? String(init.body)
          : undefined;
    const deadline = Date.now() + LOCAL_RUNTIME_RETRY_MS;
    for (;;) {
      const { status, body: raw } = await window.tud.api.request(input, {
        method: init?.method,
        body,
        headers,
      });
      if (status === 503 || isRuntimeNotReadyBody(raw)) {
        if (Date.now() >= deadline) {
          return {
            success: false,
            message: LOCAL_RUNTIME_RECOVERING_HINT,
            data: null,
          };
        }
        await sleep(LOCAL_RUNTIME_RETRY_GAP_MS);
        continue;
      }
      if (status >= 400 && (raw == null || typeof raw !== 'object')) {
        throw new Error(`${init?.method ?? 'GET'} ${input} → ${status}`);
      }
      return raw as Envelope<T>;
    }
  }

  const res = await fetch(input, init);
  try {
    return (await res.json()) as Envelope<T>;
  } catch {
    throw new Error(`${init?.method ?? 'GET'} ${input} → ${res.status}`);
  }
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
const PUBLIC_API_ROOT = (
  import.meta.env.VITE_API_BASE ?? 'https://api.juejin.cn/aiusage_api'
).replace(/\/$/, '');

/**
 * Electron preload exposes in-process local-api (CLI path contract).
 * Outside Electron, renderer falls back to the cloud HTTP API.
 */
export function isCliBackend(): boolean {
  return hasDesktopApi();
}

/**
 * Path prefix for function endpoints.
 * - IPC local-api: `/functions/tud-*` (no `/api`, relative path for preload)
 * - browser fallback: `${PUBLIC_API_ROOT}/functions/tud-*`
 */
function functionsPrefix(): string {
  return isCliBackend()
    ? '/functions/tud-'
    : `${PUBLIC_API_ROOT}/functions/tud-`;
}

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
 * Build headers for a Server-bound fetch. Includes the Bearer token
 * when one is configured (Settings or `VITE_API_BEARER`).
 */
function authHeaders(): Record<string, string> {
  const token = getApiBearer();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
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

export async function fetchSyncStatus(): Promise<SyncStatus> {
  const { others } = apiPrefixes();
  return request<SyncStatus>(`${others}sync-status`, { headers: authHeaders() });
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
    fetchSyncStatus().catch(() => null),
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

/** Thin refetch when daily cache already covers the heatmap window. */
export async function fetchUsageDatasetThin(
  previous: UsageDataset,
  breakdownDays: number,
  hourlyDays: number,
): Promise<UsageDataset> {
  const [summary, syncStatus, hourly, models] = await Promise.all([
    fetchSummary(),
    fetchSyncStatus().catch(() => null),
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

/** User-facing hint for load/sync failures (IPC local-api vs server). */
export function apiErrorHint(message: string): string | null {
  const lower = message.toLowerCase();
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('local_runtime_not_ready') ||
    message.includes(LOCAL_RUNTIME_RECOVERING_HINT) ||
    message.includes('→ 404') ||
    message.includes('→ 503')
  ) {
    return isCliBackend()
      ? LOCAL_RUNTIME_RECOVERING_HINT
      : '请先运行 pnpm start，或确认 API 服务已启动。';
  }
  if (lower.includes('unauthorized') || message.includes('401')) {
    return isCliBackend()
      ? null
      : '请在「设置」中配置鉴权 Token，或检查 Token 是否有效。';
  }
  return null;
}

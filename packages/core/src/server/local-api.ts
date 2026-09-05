import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';

import type { LocalApiDeps } from './state.js';
import {
  aggregateDaily,
  aggregateHourly,
  aggregateModelBreakdown,
} from '../aggregate.js';
import { resolveLinkedUserId, resolveLocalCollectSince, saveConfig } from '../config.js';
import { LEADERBOARD_DEFAULT_LIMIT } from '../leaderboard.js';
import type {
  LeaderboardBoard,
  LeaderboardMetric,
  LeaderboardOverviewResponse,
  LeaderboardRange,
  LeaderboardResponse,
  TudConfig,
  TudConfigUpdate,
  TudConfigView,
} from '../types.js';
import { normalizeApiUrl, uploadToServer } from '../upload/index.js';
import {
  ensureLocalCollectRange,
  getHookStatus,
  getUsageSummary,
  runSync,
  getSyncStatusPayload,
} from './state.js';

function ok<T>(data: T) {
  return { success: true as const, message: 'ok', data };
}

/** Strip accidental JSON quotes around ids written by older clients. */
function stripWrappingQuotes(raw: string | null | undefined): string | null {
  let value = raw?.trim() || null;
  if (!value) return null;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim() || null;
  }
  return value;
}

function normalizeStoredToken(raw: string | null | undefined): string | null {
  return stripWrappingQuotes(raw);
}

function looksLikePlainJuejinUserId(value: string): boolean {
  return /^\d{6,20}$/.test(value);
}

function toConfigView(config: TudConfig): TudConfigView {
  const token = normalizeStoredToken(config.juejin.token);
  const originUserId =
    stripWrappingQuotes(config.juejin.originUserId) ||
    (token && looksLikePlainJuejinUserId(token) ? token : null);
  const userName = config.juejin.userName?.trim() || null;
  const avatarLarge = config.juejin.avatarLarge?.trim() || null;
  return {
    deviceId: config.deviceId,
    statsSince: config.statsSince,
    localCollectSince: resolveLocalCollectSince(config),
    lastSyncAt: config.lastSyncAt ?? null,
    lastUploadAt: config.lastUploadAt ?? null,
    juejin: {
      enabled: config.juejin.enabled,
      apiUrl: config.juejin.apiUrl,
      authMode: config.juejin.authMode,
      hasToken: Boolean(token),
      // Null when unset or still the deviceId unlinked placeholder.
      userId: resolveLinkedUserId(config.deviceId, token),
      originUserId,
      userName,
      avatarLarge,
    },
  };
}

function isValidApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const LEADERBOARD_DEFAULT_DAYS = 30;

function parseClampedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

function parseLeaderboardMetric(
  raw: string | undefined,
): LeaderboardMetric | null {
  if (raw === undefined || raw === '') return 'tokens';
  return raw === 'cost' || raw === 'tokens' ? raw : null;
}

function parseLeaderboardRange(
  raw: string | undefined,
): LeaderboardRange | null {
  if (raw === undefined || raw === '') return 'week';
  return raw === 'today' || raw === 'week' || raw === 'month' || raw === 'all'
    ? raw
    : null;
}

function unconfiguredLeaderboard(
  days: number,
  limit: number,
  metric: LeaderboardMetric,
): LeaderboardResponse {
  return {
    configured: false,
    metric,
    days,
    limit,
    generatedAt: new Date().toISOString(),
    totalUsers: 0,
    rows: [],
    currentUser: null,
  };
}

function emptyLeaderboardBoard(metric: LeaderboardMetric): LeaderboardBoard {
  return {
    metric,
    totalUsers: 0,
    rows: [],
    currentUser: null,
  };
}

function unconfiguredLeaderboardOverview(
  range: LeaderboardRange,
  limit: number,
): LeaderboardOverviewResponse {
  const emptyBoards = () => ({
    cost: emptyLeaderboardBoard('cost'),
    tokens: emptyLeaderboardBoard('tokens'),
  });
  const days = range === 'today' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : null;
  return {
    configured: false,
    range,
    days,
    limit,
    generatedAt: new Date().toISOString(),
    global: emptyBoards(),
    tools: [],
  };
}

type LeaderboardUpstreamResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 401 | 429 | 502;
      message:
        | 'LEADERBOARD_UNAUTHENTICATED'
        | 'LEADERBOARD_RATE_LIMITED'
        | 'LEADERBOARD_UNAVAILABLE'
        | 'LEADERBOARD_UPSTREAM_ERROR';
    };

interface LeaderboardPreference {
  hideFromLeaderboard: boolean;
}

async function fetchLeaderboardUpstream<T>(
  url: URL,
  token: string,
  init?: { method?: string; body?: string },
): Promise<LeaderboardUpstreamResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init?.body,
    });
  } catch {
    return { ok: false, status: 502, message: 'LEADERBOARD_UNAVAILABLE' };
  }

  if (response.status === 401) {
    return {
      ok: false,
      status: 401,
      message: 'LEADERBOARD_UNAUTHENTICATED',
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      status: 429,
      message: 'LEADERBOARD_RATE_LIMITED',
    };
  }
  if (!response.ok) {
    return { ok: false, status: 502, message: 'LEADERBOARD_UPSTREAM_ERROR' };
  }

  let upstream: { success?: boolean; data?: T | null };
  try {
    upstream = await response.json() as typeof upstream;
  } catch {
    return { ok: false, status: 502, message: 'LEADERBOARD_UPSTREAM_ERROR' };
  }
  if (upstream.success !== true || !upstream.data) {
    return { ok: false, status: 502, message: 'LEADERBOARD_UPSTREAM_ERROR' };
  }
  return { ok: true, data: upstream.data };
}

function mapUpstreamError(
  upstream: Extract<LeaderboardUpstreamResult<unknown>, { ok: false }>,
) {
  return {
    body: { success: false as const, message: upstream.message, data: null },
    status: upstream.status,
  };
}

export function createLocalApiApp(deps: LocalApiDeps): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.get('/health', (c) => c.json({ ok: true }));

  const summaryHandler = async (c: Context) => {
    const config = deps.getConfig();
    const rows = deps.bucketStore.getRows();
    const statsSince = resolveLocalCollectSince(config);
    if (deps.aggregateCache) {
      await deps.aggregateCache.ensureLoaded();
      return c.json(ok(deps.aggregateCache.getUsageSummary(rows, statsSince)));
    }
    return c.json(ok(getUsageSummary(config, rows)));
  };

  app.get('/functions/tud-usage-summary', summaryHandler);
  app.get('/functions/tud-account-usage-summary', summaryHandler);

  app.get('/functions/tud-usage-daily', async (c) => {
    const config = deps.getConfig();
    const rows = deps.bucketStore.getRows();
    const days = Math.min(365, Math.max(1, Number(c.req.query('days')) || 90));
    const statsSince = resolveLocalCollectSince(config);
    if (deps.aggregateCache) {
      await deps.aggregateCache.ensureLoaded();
      return c.json(ok(deps.aggregateCache.getDaily(rows, days, statsSince)));
    }
    return c.json(ok(aggregateDaily(rows, days, statsSince)));
  });

  app.get('/functions/tud-usage-hourly', async (c) => {
    const config = deps.getConfig();
    const rows = deps.bucketStore.getRows();
    const days = Math.min(365, Math.max(1, Number(c.req.query('days')) || 1));
    const statsSince = resolveLocalCollectSince(config);
    if (deps.aggregateCache) {
      await deps.aggregateCache.ensureLoaded();
      return c.json(ok(deps.aggregateCache.getHourly(rows, days, statsSince)));
    }
    return c.json(ok(aggregateHourly(rows, days, statsSince)));
  });

  app.get('/functions/tud-usage-model-breakdown', async (c) => {
    const config = deps.getConfig();
    const rows = deps.bucketStore.getRows();
    const days = Math.min(365, Math.max(1, Number(c.req.query('days')) || 30));
    const statsSince = resolveLocalCollectSince(config);
    if (deps.aggregateCache) {
      await deps.aggregateCache.ensureLoaded();
      return c.json(
        ok(deps.aggregateCache.getModelBreakdown(rows, days, statsSince)),
      );
    }
    return c.json(ok(aggregateModelBreakdown(rows, days, statsSince)));
  });

  app.get('/functions/tud-leaderboard', async (c) => {
    const days = parseClampedInteger(
      c.req.query('days'),
      LEADERBOARD_DEFAULT_DAYS,
      1,
      365,
    );
    const limit = parseClampedInteger(
      c.req.query('limit'),
      LEADERBOARD_DEFAULT_LIMIT,
      1,
      LEADERBOARD_DEFAULT_LIMIT,
    );
    const metric = parseLeaderboardMetric(c.req.query('metric'));
    if (days === null || limit === null || metric === null) {
      return c.json(
        { success: false, message: 'INVALID_REQUEST', data: null },
        400,
      );
    }
    const config = deps.getConfig();
    const apiUrl = config.juejin.apiUrl?.trim().replace(/\/$/, '');
    const token = config.juejin.token?.trim();

    if (!config.juejin.enabled || !apiUrl || !token) {
      return c.json(ok(unconfiguredLeaderboard(days, limit, metric)));
    }

    const url = new URL(`${apiUrl}/functions/tud-leaderboard`);
    url.searchParams.set('days', String(days));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('metric', metric);

    const upstream = await fetchLeaderboardUpstream<LeaderboardResponse>(
      url,
      token,
    );
    if (!upstream.ok) {
      if (upstream.status === 401) {
        return c.json(
          { success: false, message: upstream.message, data: null },
          401,
        );
      }
      if (upstream.status === 429) {
        return c.json(
          { success: false, message: upstream.message, data: null },
          429,
        );
      }
      return c.json(
        { success: false, message: upstream.message, data: null },
        502,
      );
    }
    return c.json(ok(upstream.data));
  });

  app.get('/functions/tud-leaderboard-overview', async (c) => {
    const range = parseLeaderboardRange(c.req.query('range'));
    const limit = parseClampedInteger(
      c.req.query('limit'),
      LEADERBOARD_DEFAULT_LIMIT,
      1,
      LEADERBOARD_DEFAULT_LIMIT,
    );
    if (range === null || limit === null) {
      return c.json(
        { success: false, message: 'INVALID_REQUEST', data: null },
        400,
      );
    }

    const config = deps.getConfig();
    const apiUrl = config.juejin.apiUrl?.trim().replace(/\/$/, '');
    const token = config.juejin.token?.trim();
    if (!config.juejin.enabled || !apiUrl || !token) {
      return c.json(ok(unconfiguredLeaderboardOverview(range, limit)));
    }

    const url = new URL(`${apiUrl}/functions/tud-leaderboard-overview`);
    url.searchParams.set('range', range);
    url.searchParams.set('limit', String(limit));

    const upstream = await fetchLeaderboardUpstream<LeaderboardOverviewResponse>(
      url,
      token,
    );
    if (!upstream.ok) {
      if (upstream.status === 401) {
        return c.json(
          { success: false, message: upstream.message, data: null },
          401,
        );
      }
      if (upstream.status === 429) {
        return c.json(
          { success: false, message: upstream.message, data: null },
          429,
        );
      }
      return c.json(
        { success: false, message: upstream.message, data: null },
        502,
      );
    }
    return c.json(ok(upstream.data));
  });

  app.get('/functions/tud-leaderboard-preference', async (c) => {
    const config = deps.getConfig();
    const apiUrl = config.juejin.apiUrl?.trim().replace(/\/$/, '');
    const token = config.juejin.token?.trim();
    if (!config.juejin.enabled || !apiUrl || !token) {
      return c.json(ok({ hideFromLeaderboard: false } satisfies LeaderboardPreference));
    }

    const url = new URL(`${apiUrl}/functions/tud-leaderboard-preference`);
    const upstream = await fetchLeaderboardUpstream<LeaderboardPreference>(
      url,
      token,
    );
    if (!upstream.ok) {
      const mapped = mapUpstreamError(upstream);
      return c.json(mapped.body, mapped.status);
    }
    return c.json(ok(upstream.data));
  });

  app.put('/functions/tud-leaderboard-preference', async (c) => {
    let body: LeaderboardPreference;
    try {
      body = await c.req.json<LeaderboardPreference>();
    } catch {
      return c.json(
        { success: false, message: 'INVALID_REQUEST', data: null },
        400,
      );
    }
    if (typeof body?.hideFromLeaderboard !== 'boolean') {
      return c.json(
        { success: false, message: 'INVALID_REQUEST', data: null },
        400,
      );
    }

    const config = deps.getConfig();
    const apiUrl = config.juejin.apiUrl?.trim().replace(/\/$/, '');
    const token = config.juejin.token?.trim();
    if (!config.juejin.enabled || !apiUrl || !token) {
      return c.json(
        { success: false, message: 'LEADERBOARD_UNAVAILABLE', data: null },
        502,
      );
    }

    const url = new URL(`${apiUrl}/functions/tud-leaderboard-preference`);
    const upstream = await fetchLeaderboardUpstream<LeaderboardPreference>(
      url,
      token,
      {
        method: 'PUT',
        body: JSON.stringify({
          hideFromLeaderboard: body.hideFromLeaderboard,
        }),
      },
    );
    if (!upstream.ok) {
      const mapped = mapUpstreamError(upstream);
      return c.json(mapped.body, mapped.status);
    }
    return c.json(ok(upstream.data));
  });

  app.get('/functions/tud-sync-status', async (c) => {
    const config = deps.getConfig();
    const rows = deps.bucketStore.getRows();
    const hooks = deps.getHookStatus
      ? await deps.getHookStatus()
      : await getHookStatus(deps.dataDir);
    return c.json(ok(await getSyncStatusPayload(deps.dataDir, config, rows, hooks)));
  });

  app.get('/functions/tud-config', async (c) => {
    return c.json(ok(toConfigView(deps.getConfig())));
  });

  app.put('/functions/tud-config', async (c) => {
    let body: TudConfigUpdate;
    try {
      body = await c.req.json<TudConfigUpdate>();
    } catch {
      return c.json({ success: false, message: 'INVALID_JSON', data: null }, 400);
    }

    const activeConfig = deps.getConfig();
    // Stage edits so validation or persistence failures cannot mutate the
    // configuration currently used by the local runtime.
    const config = { ...activeConfig, juejin: { ...activeConfig.juejin } };
    const prevApiUrl = normalizeApiUrl(config.juejin.apiUrl ?? '');
    const prevToken = config.juejin.token?.trim() || null;
    const prevEnabled = config.juejin.enabled;

    if (body.juejin) {
      if (body.juejin.enabled !== undefined) {
        config.juejin.enabled = body.juejin.enabled;
      }
      if (body.juejin.apiUrl !== undefined) {
        const url = body.juejin.apiUrl.trim();
        if (!isValidApiUrl(url)) {
          return c.json({ success: false, message: 'INVALID_API_URL', data: null }, 400);
        }
        config.juejin.apiUrl = url;
      }
      if (body.juejin.token !== undefined) {
        const token = normalizeStoredToken(body.juejin.token);
        config.juejin.token = token;
        // Legacy plain business id: keep a display copy when caller omitted it.
        if (
          token &&
          looksLikePlainJuejinUserId(token) &&
          body.juejin.originUserId === undefined &&
          !config.juejin.originUserId?.trim()
        ) {
          config.juejin.originUserId = token;
        }
      }
      if (body.juejin.originUserId !== undefined) {
        config.juejin.originUserId = stripWrappingQuotes(
          body.juejin.originUserId,
        );
      }
      if (body.juejin.userName !== undefined) {
        config.juejin.userName = body.juejin.userName?.trim() || null;
      }
      if (body.juejin.avatarLarge !== undefined) {
        config.juejin.avatarLarge = body.juejin.avatarLarge?.trim() || null;
      }
    }

    await saveConfig(deps.dataDir, config);
    // Preserve getConfig() callers that keep the original object and do not
    // provide an onConfigChange callback.
    activeConfig.juejin = config.juejin;
    deps.onConfigChange?.(activeConfig);

    const nextApiUrl = normalizeApiUrl(config.juejin.apiUrl ?? '');
    const nextToken = config.juejin.token?.trim() || null;
    const remoteChanged =
      nextApiUrl !== prevApiUrl ||
      nextToken !== prevToken ||
      (config.juejin.enabled && !prevEnabled);

    if (config.juejin.enabled && remoteChanged && nextApiUrl && nextToken) {
      void uploadToServer(deps.dataDir, config, { fullScan: true }).catch((err) => {
        console.warn(
          '换远端后自动补报失败:',
          err instanceof Error ? err.message : err,
        );
      });
    }

    return c.json(ok(toConfigView(config)));
  });

  app.post('/functions/tud-trigger-sync', async (c) => {
    let source: string | undefined;
    try {
      const body = await c.req.json<{ source?: string }>();
      source = body?.source;
    } catch {
      // empty body ok
    }
    const result = await runSync(deps, source);
    return c.json(
      ok({
        ok: result.ok,
        results: result.results,
        message: 'sync complete',
      }),
    );
  });

  app.post('/functions/tud-ensure-local-range', async (c) => {
    let days = 7;
    try {
      const body = await c.req.json<{ days?: number }>();
      if (body?.days != null) days = Number(body.days);
    } catch {
      // empty body → default 7
    }
    try {
      const result = await ensureLocalCollectRange(deps, days);
      return c.json(
        ok({
          expanded: result.expanded,
          localCollectSince: resolveLocalCollectSince(result.config),
          statsSince: result.config.statsSince,
          sync: result.sync
            ? { ok: result.sync.ok, results: result.sync.results }
            : null,
          message: result.expanded
            ? 'local range expanded and synced'
            : 'local range already covered',
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('INVALID_RANGE_DAYS')) {
        return c.json({ success: false, message: 'INVALID_RANGE_DAYS', data: null }, 400);
      }
      throw err;
    }
  });

  return app;
}

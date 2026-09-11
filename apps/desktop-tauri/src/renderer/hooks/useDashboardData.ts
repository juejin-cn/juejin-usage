import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import {
  ensureLocalRange,
  fetchSyncStatus,
  fetchUsageDataset,
  fetchUsageDatasetThin,
  type UsageDataset,
} from '@/lib/api';
import {
  buildDashboardDataFromDataset,
  stabilizeDashboardData,
} from '@/lib/dashboard-data';
import { resolveDashboardFetchDays } from '@/lib/dashboard-fetch-days';
import {
  emptyDashboardData,
  type DashboardMockData,
} from '@/lib/dashboard-mock-data';
import { fingerprintUsageDataset } from '@/lib/usage-dataset-fingerprint';

export type DashboardDataSource = 'api';

interface DashboardDataState {
  data: DashboardMockData;
  source: DashboardDataSource;
  loading: boolean;
  refreshing: boolean;
  /** Local ensure+resync for an expanded today/7D/30D/90D window. */
  syncingRange: boolean;
  error: string | null;
}

/** Last successful view per range so tab switches render instantly. */
interface RangeCacheEntry {
  fingerprint: string | null;
  data: DashboardMockData;
  error: string | null;
}

export { resolveDashboardFetchDays } from '@/lib/dashboard-fetch-days';

/** Foreground poll interval. */
const POLL_MS = 10_000;

/**
 * Load the same usage snapshot as the root page.
 *
 * Desktop reads via IPC → in-process local-api (same ~/.ai-usage as CLI).
 * Empty or failed responses remain empty so the UI never substitutes sample data.
 *
 * CPU-friendly refresh strategy:
 * - Tab switches to an already-visited range show the cached view immediately
 *   and revalidate in the background (no blocking fetch, no spinner).
 * - Foreground polls probe the cheap sync-status endpoint first and skip the
 *   full 5-request dataset reload when `lastSyncAt` has not moved.
 * - Rebuilt data is stabilized against the previous reference so unchanged
 *   fields (heatmap window, model rows, …) keep their identity and memoized
 *   charts skip re-rendering.
 */
export function useDashboardData(
  rangeDays: number,
  selectedDate?: string | null,
) {
  const [revision, setRevision] = useState(0);
  /** Largest range (days) already ensure'd this session — shrinking skips ensure. */
  const ensuredMaxDaysRef = useRef(0);
  const lastFetchedRangeDaysRef = useRef<number | null>(null);
  const lastRevisionRef = useRef<number | null>(null);
  const datasetCacheRef = useRef<UsageDataset | null>(null);
  const cachedDailyDaysRef = useRef(0);
  const cachedHourlyDaysRef = useRef(0);
  const rangeFetchInFlightRef = useRef(false);
  const lastFingerprintRef = useRef<string | null>(null);
  const dataRef = useRef<DashboardMockData>(emptyDashboardData);
  const rangeCacheRef = useRef(new Map<number, RangeCacheEntry>());
  /** `lastSyncAt` seen on the most recent full fetch — poll freshness probe. */
  const lastSeenSyncAtRef = useRef<string | null>(null);
  const [state, setState] = useState<DashboardDataState>(() => ({
    data: emptyDashboardData,
    source: 'api',
    loading: true,
    refreshing: false,
    syncingRange: false,
    error: null,
  }));

  const reload = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchDays = resolveDashboardFetchDays(rangeDays, selectedDate);
    const needsEnsure = rangeDays > ensuredMaxDaysRef.current;
    const isEmpty = (data: DashboardMockData) => data === emptyDashboardData;
    const isRangeDrivenRefresh =
      lastFetchedRangeDaysRef.current != null &&
      lastFetchedRangeDaysRef.current !== rangeDays;
    const revisionChanged = lastRevisionRef.current !== revision;
    lastRevisionRef.current = revision;
    const hourlyAlreadyCovered =
      datasetCacheRef.current != null &&
      lastFetchedRangeDaysRef.current === rangeDays &&
      cachedHourlyDaysRef.current >= fetchDays.hourlyDays &&
      !needsEnsure;
    if (!revisionChanged && hourlyAlreadyCovered) {
      return () => {
        cancelled = true;
      };
    }
    const isHourlyExpansion =
      lastFetchedRangeDaysRef.current === rangeDays &&
      datasetCacheRef.current != null &&
      cachedDailyDaysRef.current >= fetchDays.dailyDays &&
      cachedHourlyDaysRef.current < fetchDays.hourlyDays &&
      !needsEnsure;
    const cachedEntry =
      isRangeDrivenRefresh && !needsEnsure
        ? rangeCacheRef.current.get(rangeDays)
        : undefined;

    if (isRangeDrivenRefresh || isHourlyExpansion) {
      rangeFetchInFlightRef.current = true;
    }

    if (cachedEntry) {
      // Tab switch back to a visited range: render the cached view now and
      // revalidate in the background without loading/refreshing overlays.
      lastFingerprintRef.current = cachedEntry.fingerprint;
      dataRef.current = cachedEntry.data;
      setState({
        data: cachedEntry.data,
        source: 'api',
        loading: false,
        refreshing: false,
        syncingRange: false,
        error: cachedEntry.error,
      });
    } else {
      setState((current) => {
        if (isEmpty(current.data)) {
          return {
            ...current,
            loading: true,
            refreshing: false,
            syncingRange: false,
            error: null,
          };
        }
        if (isRangeDrivenRefresh) {
          return {
            ...current,
            loading: false,
            refreshing: true,
            syncingRange: false,
            error: null,
          };
        }
        return current;
      });
    }

    const applyResult = (next: DashboardDataState) => {
      startTransition(() => {
        if (cancelled) return;
        lastFetchedRangeDaysRef.current = rangeDays;
        rangeFetchInFlightRef.current = false;
        dataRef.current = next.data;
        setState(next);
      });
    };

    const run = async () => {
      try {
        if (needsEnsure) {
          await ensureLocalRange(rangeDays);
          if (cancelled) return;
          ensuredMaxDaysRef.current = Math.max(
            ensuredMaxDaysRef.current,
            rangeDays,
          );
          datasetCacheRef.current = null;
          cachedDailyDaysRef.current = 0;
          cachedHourlyDaysRef.current = 0;
          lastFingerprintRef.current = null;
          rangeCacheRef.current.clear();
        }

        const canReuseDaily =
          datasetCacheRef.current != null &&
          cachedDailyDaysRef.current >= fetchDays.dailyDays &&
          !needsEnsure &&
          (isRangeDrivenRefresh || isHourlyExpansion);

        const dataset = canReuseDaily
          ? await fetchUsageDatasetThin(
              datasetCacheRef.current!,
              fetchDays.breakdownDays,
              fetchDays.hourlyDays,
            )
          : await fetchUsageDataset(fetchDays);
        if (cancelled || !dataset) return;

        datasetCacheRef.current = dataset;
        cachedHourlyDaysRef.current = fetchDays.hourlyDays;
        if (!canReuseDaily) {
          cachedDailyDaysRef.current = fetchDays.dailyDays;
        }
        lastSeenSyncAtRef.current =
          dataset.syncStatus?.lastSyncAt ?? lastSeenSyncAtRef.current;

        const hasUsageRows = dataset.dailyRows.length > 0;
        if (hasUsageRows) {
          const fingerprint = fingerprintUsageDataset(dataset, rangeDays);
          const prior = dataRef.current;
          if (
            fingerprint === lastFingerprintRef.current &&
            prior !== emptyDashboardData
          ) {
            // Same content: keep previous data reference; bail if already idle.
            rangeCacheRef.current.set(rangeDays, {
              fingerprint,
              data: prior,
              error: null,
            });
            startTransition(() => {
              if (cancelled) return;
              lastFetchedRangeDaysRef.current = rangeDays;
              rangeFetchInFlightRef.current = false;
              setState((current) => {
                if (
                  !current.loading &&
                  !current.refreshing &&
                  !current.syncingRange &&
                  current.data === prior &&
                  current.error == null
                ) {
                  return current;
                }
                return {
                  data: prior,
                  source: 'api',
                  loading: false,
                  refreshing: false,
                  syncingRange: false,
                  error: null,
                };
              });
            });
            return;
          }
          lastFingerprintRef.current = fingerprint;
          const data = stabilizeDashboardData(
            dataRef.current,
            buildDashboardDataFromDataset(dataset, rangeDays),
          );
          rangeCacheRef.current.set(rangeDays, {
            fingerprint,
            data,
            error: null,
          });
          applyResult({
            data,
            source: 'api',
            loading: false,
            refreshing: false,
            syncingRange: false,
            error: null,
          });
          return;
        }

        const emptyFingerprint = `empty|${rangeDays}`;
        const emptyError = '当前时间范围暂无用量记录';
        lastFingerprintRef.current = emptyFingerprint;
        rangeCacheRef.current.set(rangeDays, {
          fingerprint: emptyFingerprint,
          data: emptyDashboardData,
          error: emptyError,
        });
        applyResult({
          data: emptyDashboardData,
          source: 'api',
          loading: false,
          refreshing: false,
          syncingRange: false,
          error: emptyError,
        });
      } catch (error: unknown) {
        if (cancelled) return;
        rangeFetchInFlightRef.current = false;
        const message =
          error instanceof Error ? error.message : '数据加载失败';
        if (cachedEntry) {
          // Background revalidation failed — keep showing the cached view.
          startTransition(() => {
            if (cancelled) return;
            lastFetchedRangeDaysRef.current = rangeDays;
            setState((current) => ({
              ...current,
              loading: false,
              refreshing: false,
              syncingRange: false,
              error: message,
            }));
          });
          return;
        }
        lastFingerprintRef.current = null;
        applyResult({
          data: emptyDashboardData,
          source: 'api',
          loading: false,
          refreshing: false,
          syncingRange: false,
          error: message,
        });
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [rangeDays, selectedDate, revision]);

  useEffect(() => {
    let probing = false;

    const maybeReload = () => {
      if (document.visibilityState === 'hidden') return;
      if (rangeFetchInFlightRef.current || probing) return;
      probing = true;
      void (async () => {
        let changed = true;
        try {
          // Cheap freshness probe: skip the full 5-request dataset reload
          // when the runtime has not synced since our last fetch.
          const status = await fetchSyncStatus();
          const stamp = status.lastSyncAt ?? null;
          changed = stamp == null || stamp !== lastSeenSyncAtRef.current;
        } catch {
          // sync-status unavailable — fall back to a full reload.
        } finally {
          probing = false;
        }
        if (changed) reload();
      })();
    };

    const timer = window.setInterval(maybeReload, POLL_MS);
    window.addEventListener('focus', maybeReload);
    document.addEventListener('visibilitychange', maybeReload);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', maybeReload);
      document.removeEventListener('visibilitychange', maybeReload);
    };
  }, [reload]);

  return {
    ...state,
    reload,
  };
}

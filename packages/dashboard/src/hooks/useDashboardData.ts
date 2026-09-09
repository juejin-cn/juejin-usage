import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import {
  ensureLocalRange,
  fetchUsageDataset,
  fetchUsageDatasetThin,
  isCliBackend,
  type UsageDataset,
} from '@/lib/api';
import {
  buildDashboardDataFromDataset,
  withClippedTodayHourly,
} from '@/lib/dashboard-data';
import { resolveDashboardFetchDays } from '@/lib/dashboard-fetch-days';
import {
  dashboardMockData,
  emptyDashboardData,
  type DashboardMockData,
} from '@/lib/dashboard-mock-data';
import { isMockDataEnabled } from '@/lib/env';
import { fingerprintUsageDataset } from '@/lib/usage-dataset-fingerprint';

export type DashboardDataSource = 'api' | 'sample';

interface DashboardDataState {
  data: DashboardMockData;
  source: DashboardDataSource;
  loading: boolean;
  refreshing: boolean;
  /** Local ensure+resync for an expanded today/7D/30D/90D window. */
  syncingRange: boolean;
  error: string | null;
}

export { resolveDashboardFetchDays } from '@/lib/dashboard-fetch-days';

/** Foreground poll interval; use setInterval (not rAF) to avoid 60Hz wakeups. */
const POLL_MS = 10_000;

/**
 * Load the same usage snapshot as the root page.
 *
 * Reload/poll with an unchanged fingerprint keeps the previous `data`
 * reference so Recharts / heatmap do not rebuild.
 */
export function useDashboardData(
  rangeDays: number,
  selectedDate?: string | null,
) {
  const mockEnabled = isMockDataEnabled();
  const cliBackend = isCliBackend();
  const { authStatus } = useJuejinAuth();
  const [revision, setRevision] = useState(0);
  const ensuredMaxDaysRef = useRef(0);
  const lastFetchedRangeDaysRef = useRef<number | null>(null);
  const lastRevisionRef = useRef<number | null>(null);
  const datasetCacheRef = useRef<UsageDataset | null>(null);
  const cachedDailyDaysRef = useRef(0);
  const cachedHourlyDaysRef = useRef(0);
  const rangeFetchInFlightRef = useRef(false);
  const lastFingerprintRef = useRef<string | null>(null);
  const dataRef = useRef<DashboardMockData>(
    mockEnabled ? withClippedTodayHourly(dashboardMockData) : emptyDashboardData,
  );
  const [state, setState] = useState<DashboardDataState>(() => ({
    data: mockEnabled
      ? withClippedTodayHourly(dashboardMockData)
      : emptyDashboardData,
    source: mockEnabled ? 'sample' : 'api',
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

    if (!cliBackend && !mockEnabled) {
      if (authStatus === 'loading') {
        setState((current) => ({
          ...current,
          loading: true,
          refreshing: false,
          syncingRange: false,
          error: null,
        }));
        return () => {
          cancelled = true;
        };
      }
      if (authStatus === 'unauthenticated') {
        setState({
          data: emptyDashboardData,
          source: 'api',
          loading: false,
          refreshing: false,
          syncingRange: false,
          error: '未登录掘金账号，请先登录后查看个人用量',
        });
        dataRef.current = emptyDashboardData;
        return () => {
          cancelled = true;
        };
      }
    }

    const needsEnsure = cliBackend && rangeDays > ensuredMaxDaysRef.current;
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

    if (isRangeDrivenRefresh || isHourlyExpansion) {
      rangeFetchInFlightRef.current = true;
    }

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
        }

        const canReuseDaily =
          !cliBackend &&
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

        const hasUsageRows = dataset.dailyRows.length > 0;
        if (hasUsageRows) {
          const fingerprint = fingerprintUsageDataset(dataset, rangeDays);
          const prior = dataRef.current;
          if (
            fingerprint === lastFingerprintRef.current &&
            prior !== emptyDashboardData
          ) {
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
          applyResult({
            data: buildDashboardDataFromDataset(dataset, rangeDays, cliBackend),
            source: 'api',
            loading: false,
            refreshing: false,
            syncingRange: false,
            error: null,
          });
          return;
        }

        const emptyMessage = '当前时间范围暂无用量记录';
        lastFingerprintRef.current = `empty|${rangeDays}`;
        if (mockEnabled) {
          applyResult({
            data: withClippedTodayHourly(dashboardMockData),
            source: 'sample',
            loading: false,
            refreshing: false,
            syncingRange: false,
            error: emptyMessage,
          });
          return;
        }

        applyResult({
          data: buildDashboardDataFromDataset(dataset, rangeDays, cliBackend),
          source: 'api',
          loading: false,
          refreshing: false,
          syncingRange: false,
          error: emptyMessage,
        });
      } catch (error: unknown) {
        if (cancelled) return;
        rangeFetchInFlightRef.current = false;
        lastFingerprintRef.current = null;
        const message =
          error instanceof Error ? error.message : '数据加载失败';
        if (mockEnabled) {
          applyResult({
            data: withClippedTodayHourly(dashboardMockData),
            source: 'sample',
            loading: false,
            refreshing: false,
            syncingRange: false,
            error: message,
          });
          return;
        }

        applyResult({
          data:
            lastFetchedRangeDaysRef.current === rangeDays
              ? dataRef.current
              : emptyDashboardData,
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
  }, [rangeDays, selectedDate, revision, mockEnabled, cliBackend, authStatus]);

  useEffect(() => {
    if (!isCliBackend()) return;

    const poll = () => {
      if (document.visibilityState === 'hidden') return;
      if (rangeFetchInFlightRef.current) return;
      reload();
    };
    const timer = window.setInterval(poll, POLL_MS);

    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      if (rangeFetchInFlightRef.current) return;
      reload();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [reload]);

  return {
    ...state,
    reload,
  };
}

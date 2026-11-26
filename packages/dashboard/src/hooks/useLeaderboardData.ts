import { useCallback, useEffect, useRef, useState } from 'react';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import {
  fetchLeaderboardOverview,
  isCliBackend,
  type LeaderboardFilters,
  type LeaderboardOverviewResponse,
  type LeaderboardRange,
} from '@/lib/api';
import { isMockDataEnabled } from '@/lib/env';
import { createMockLeaderboardOverview } from '@/lib/leaderboard-mock-data';

interface LeaderboardDataState {
  data: LeaderboardOverviewResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

/** Foreground poll interval; rAF pauses when the tab is backgrounded. */
const POLL_MS = 10_000;

function requestKey(range: LeaderboardRange, filters: LeaderboardFilters) {
  return `${range}|${filters.tool ?? ''}|${filters.model ?? ''}`;
}

export function useLeaderboardData(
  range: LeaderboardRange,
  filters: LeaderboardFilters = {},
) {
  const mockEnabled = isMockDataEnabled();
  const cliBackend = isCliBackend();
  const { authStatus } = useJuejinAuth();
  const [revision, setRevision] = useState(0);
  const lastKeyRef = useRef<string | null>(null);
  const manualReloadRef = useRef(false);
  const [state, setState] = useState<LeaderboardDataState>({
    data: null,
    loading: true,
    refreshing: false,
    error: null,
  });

  const reload = useCallback((options?: { silent?: boolean }) => {
    manualReloadRef.current = options?.silent !== true;
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const key = requestKey(range, filters);

    // Server: wait for user/get to settle so authenticated calls can send user_id.
    if (!cliBackend && !mockEnabled && authStatus === 'loading') {
      setState((current) => ({
        ...current,
        loading: current.data == null,
        refreshing: false,
        error: null,
      }));
      return () => {
        cancelled = true;
      };
    }

    // Filter/range switches surface a refresh. Same-key polls stay silent.
    // Manual reloads always surface the refreshing state so the retry button
    // gives feedback even when the key is unchanged.
    const isManualReload = manualReloadRef.current;
    manualReloadRef.current = false;
    setState((current) => {
      if (current.data == null) {
        return {
          ...current,
          loading: true,
          refreshing: false,
          error: null,
        };
      }
      const isFilterChange =
        lastKeyRef.current != null && lastKeyRef.current !== key;
      if (isFilterChange || isManualReload) {
        return {
          ...current,
          loading: false,
          refreshing: true,
          error: null,
        };
      }
      return current;
    });

    const request = mockEnabled
      ? Promise.resolve(createMockLeaderboardOverview(range, filters))
      : fetchLeaderboardOverview(range, undefined, filters);

    request
      .then((data) => {
        if (cancelled) return;
        lastKeyRef.current = key;
        setState({ data, loading: false, refreshing: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState((current) => ({
          data: current.data,
          loading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : '排行榜加载失败',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [range, revision, mockEnabled, cliBackend, authStatus, filters.model, filters.tool]);

  // CLI local API has no push to the browser; rAF ~10s poll + focus reload.
  useEffect(() => {
    if (!isCliBackend()) return;

    let rafId = 0;
    let last = performance.now();

    const tick = (now: number) => {
      if (now - last >= POLL_MS) {
        last = now;
        reload({ silent: true });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const onFocus = () => {
      last = performance.now();
      reload({ silent: true });
    };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('focus', onFocus);
    };
  }, [reload]);

  return {
    ...state,
    reload,
  };
}

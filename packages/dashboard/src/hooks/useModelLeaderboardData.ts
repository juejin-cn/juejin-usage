import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchModelLeaderboardOverview,
  type LeaderboardRange,
  type ModelLeaderboardOverviewResponse,
} from '@/lib/api';
import { isMockDataEnabled } from '@/lib/env';
import { createMockModelLeaderboardOverview } from '@/lib/model-leaderboard-mock';

interface State {
  data: ModelLeaderboardOverviewResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

export function useModelLeaderboardData(
  range: LeaderboardRange,
  filters: { tool?: string; q?: string },
) {
  const [revision, setRevision] = useState(0);
  const lastKey = useRef('');
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    refreshing: false,
    error: null,
  });
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const key = `${range}|${filters.tool ?? ''}|${filters.q ?? ''}`;
    setState((current) => ({
      ...current,
      loading: current.data === null,
      refreshing: current.data !== null && key !== lastKey.current,
      error: null,
    }));
    const request = isMockDataEnabled()
      ? Promise.resolve(createMockModelLeaderboardOverview(range, filters))
      : fetchModelLeaderboardOverview(range, filters);
    void request.then((data) => {
      if (cancelled) return;
      lastKey.current = key;
      setState({ data, loading: false, refreshing: false, error: null });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : '模型排行加载失败',
      }));
    });
    return () => { cancelled = true; };
  }, [range, filters.tool, filters.q, revision]);

  const switchingLifetime = state.data && state.data.range !== range &&
    (range === 'all' || state.data.range === 'all');
  return switchingLifetime ? { ...state, data: null, loading: !state.error, reload } : { ...state, reload };
}

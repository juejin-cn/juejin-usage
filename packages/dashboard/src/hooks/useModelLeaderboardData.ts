import { useCallback, useEffect, useState } from 'react';
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
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    refreshing: false,
    error: null,
  });
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({
      ...current,
      loading: current.data === null,
      refreshing: current.data !== null,
      error: null,
    }));
    const request = isMockDataEnabled()
      ? Promise.resolve(createMockModelLeaderboardOverview(range, filters))
      : fetchModelLeaderboardOverview(range, filters);
    void request.then((data) => {
      if (cancelled) return;
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

  return { ...state, reload };
}

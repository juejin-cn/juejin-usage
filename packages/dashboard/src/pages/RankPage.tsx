import { useEffect, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { RankFilter } from '@/components/RankFilter';
import { RankUserTable } from '@/components/RankModelCards';
import { StatusBanner } from '@/components/StatusBanner';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { useLeaderboardData } from '@/hooks/useLeaderboardData';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import {
  fetchLeaderboardPreference,
  isCliBackend,
  updateLeaderboardPreference,
  type LeaderboardMetric,
} from '@/lib/api';
import { isMockDataEnabled } from '@/lib/env';
import {
  isRankRange,
  uniqueRankModelOptions,
  type RankRange,
} from '@/lib/leaderboard';
import {
  DATA_SYNCED_EVENT,
  dispatchOpenSettings,
} from '@/lib/shell-events';

export function RankPage() {
  const [range, setRange] = useLocalStorage<RankRange>(
    'tud.rankRange',
    'today',
    isRankRange,
  );
  const [tool, setTool] = useState('');
  const [model, setModel] = useState('');
  const [metric, setMetric] = useState<LeaderboardMetric>('tokens');
  const [hideFromLeaderboard, setHideFromLeaderboard] = useState(false);
  const [hideToggleSaving, setHideToggleSaving] = useState(false);
  const mockEnabled = isMockDataEnabled();
  const { data, error, loading, refreshing, reload } = useLeaderboardData(
    range,
    {
      tool: tool || undefined,
      model: model || undefined,
    },
  );
  const busy = loading || refreshing;
  const { authStatus, userId, userName, avatarLarge } = useJuejinAuth();
  const cliBackend = isCliBackend();
  // Web: personal rank UI only after Juejin login. CLI keeps local settings flow.
  const showPersonalRank = cliBackend || authStatus === 'authenticated';
  const showHideToggle = showPersonalRank && !mockEnabled;

  useEffect(() => {
    const onSynced = () => {
      void reload();
    };
    window.addEventListener(DATA_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(DATA_SYNCED_EVENT, onSynced);
  }, [reload]);

  useEffect(() => {
    if (!showHideToggle) {
      setHideFromLeaderboard(false);
      return;
    }
    let cancelled = false;
    void fetchLeaderboardPreference()
      .then((preference) => {
        if (!cancelled) setHideFromLeaderboard(preference.hideFromLeaderboard);
      })
      .catch(() => {
        if (!cancelled) setHideFromLeaderboard(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showHideToggle]);

  // CLI only — Web already surfaces login state in the top-right nav.
  const showAnonymousAuthWarn =
    cliBackend &&
    showPersonalRank &&
    !loading &&
    !error &&
    data != null &&
    data.global.cost.currentUser == null &&
    data.global.tokens.currentUser == null;

  const filterOptions = data?.filterOptions;
  const modelOptions = useMemo(
    () => uniqueRankModelOptions(filterOptions?.models ?? [], tool),
    [filterOptions?.models, tool],
  );

  const profiles = useMemo(() => {
    const result = { ...(data?.profiles ?? {}) };
    if (userId && userName) {
      result[userId] = {
        uid: userId,
        userName,
        avatarUrl: avatarLarge,
        profileUrl: `https://juejin.cn/user/${encodeURIComponent(userId)}`,
      };
    }
    return result;
  }, [data?.profiles, userId, userName, avatarLarge]);

  const onHideFromLeaderboardChange = (hide: boolean) => {
    const previous = hideFromLeaderboard;
    setHideFromLeaderboard(hide);
    setHideToggleSaving(true);
    void updateLeaderboardPreference(hide)
      .then(() => {
        reload();
      })
      .catch(() => {
        setHideFromLeaderboard(previous);
      })
      .finally(() => {
        setHideToggleSaving(false);
      });
  };

  return (
    <div aria-busy={busy} className="relative flex w-full min-w-0 flex-col">
      <RankFilter
        board={data?.global[metric] ?? null}
        loading={busy}
        metric={metric}
        model={model}
        modelOptions={modelOptions}
        onChange={setRange}
        onModelChange={setModel}
        onToolChange={(nextTool) => {
          setTool(nextTool);
          setModel('');
        }}
        profiles={profiles}
        tool={tool}
        tools={filterOptions?.tools ?? []}
        value={range}
      />

      <div className="space-y-6">
        {showAnonymousAuthWarn && (
          <div className="flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <StatusBanner
                description="无法标注你的排名。请前往设置绑定鉴权 Token，或登录后再查看个人名次。"
                title="鉴权无效或未登录"
                tone="warn"
              />
            </div>
            <Button
              className="shrink-0 self-start sm:self-center"
              onPress={() => {
                dispatchOpenSettings();
              }}
              variant="secondary"
            >
              去设置
            </Button>
          </div>
        )}
        <RankUserTable
          global={data?.global ?? null}
          hideFromLeaderboard={hideFromLeaderboard}
          hideToggleDisabled={hideToggleSaving}
          loading={loading}
          metric={metric}
          onHideFromLeaderboardChange={onHideFromLeaderboardChange}
          onMetricChange={setMetric}
          profiles={profiles}
          refreshing={refreshing}
          showHideToggle={showHideToggle}
        />
      </div>
    </div>
  );
}

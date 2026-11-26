import { PageCardHeading } from '@web/components/PageCardHeading';
import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UsageActions } from '../components/UsageActions';
import { UsageFilters } from '../components/UsageFilters';
import { DASHBOARD_RANGE_DAYS, type DashboardRange } from '@/components/DashboardFilter';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { UsageOverview, UsageSkeleton } from '../components/UsageOverview';
import { Segmented } from '../components/Segmented';
import { UsageLoginGate } from '../UsageLoginGate';

const ranges = [
  { id: 'today', label: '24H' },
  { id: 'last-7-days', label: '7D' },
  { id: 'last-30-days', label: '30D' },
  { id: 'last-90-days', label: '90D' },
] as const;

function MyUsagePage() {
  const { authStatus } = useJuejinAuth();
  const [range, setRange] = useLocalStorage<DashboardRange>(
    'tud.dashboardRange',
    'last-7-days',
    (value): value is DashboardRange => ranges.some(({ id }) => id === value),
  );
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const days = DASHBOARD_RANGE_DAYS[range];
  const { data, error, loading, refreshing, reload, source } = useDashboardData(days);
  const receiptDisabled = loading || refreshing || Boolean(error && source === 'api');

  useEffect(() => {
    const availableTools = new Set(
      data.toolModelUsage.filter((row) => row.tokens > 0).map((row) => row.source),
    );
    setSelectedTools((current) => {
      const next = current.filter((item) => availableTools.has(item));
      return next.length === current.length ? current : next;
    });
  }, [data.toolModelUsage]);

  useEffect(() => {
    const activeToolSet = selectedTools.length > 0 ? new Set(selectedTools) : null;
    const availableModels = new Set<string>();
    for (const tool of data.toolModelUsage) {
      if (tool.tokens <= 0) continue;
      if (activeToolSet && !activeToolSet.has(tool.source)) continue;
      for (const model of tool.models) {
        if (model.model && model.tokens > 0) availableModels.add(model.model);
      }
    }
    setSelectedModels((current) => {
      const next = current.filter((item) => availableModels.has(item));
      return next.length === current.length ? current : next;
    });
  }, [data.toolModelUsage, selectedTools]);

  return (
    <section aria-labelledby="my-usage-heading">
      <header className="border-b border-black/6 px-4 py-4 sm:px-5 sm:pt-6 sm:pb-5 sm:[&_h1+p]:mt-3 dark:border-white/6">
        <PageCardHeading
          id="my-usage-heading"
          title="我的用量"
          description="按工具和模型查看 Token 消耗、费用与使用趋势。"
          action={authStatus === 'authenticated' ? (
            <UsageActions receiptDisabled={receiptDisabled} />
          ) : undefined}
        />
        <div className="mt-3.5 flex flex-wrap items-center gap-2 sm:mt-5">
          <Segmented label="时间范围" options={ranges} value={range} onChange={setRange} />
          {authStatus === 'authenticated' && (
            <UsageFilters
              tools={data.toolModelUsage}
              selectedTools={selectedTools}
              onToolsChange={setSelectedTools}
              selectedModels={selectedModels}
              onModelsChange={setSelectedModels}
              disabled={loading || refreshing}
            />
          )}
        </div>
      </header>
      {authStatus === 'authenticated' ? (
        <UsageOverview
          days={days}
          data={data}
          error={error}
          loading={loading}
          refreshing={refreshing}
          reload={reload}
          source={source}
          selectedTools={selectedTools}
          selectedModels={selectedModels}
        />
      ) : authStatus === 'loading' ? <UsageSkeleton /> : <UsageLoginGate />}
    </section>
  );
}

export const Route = createFileRoute('/dashboard')({ component: MyUsagePage });

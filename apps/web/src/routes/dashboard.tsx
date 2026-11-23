import { createFileRoute } from '@tanstack/react-router';
import { UsageActions } from '../components/UsageActions';
import { DASHBOARD_RANGE_DAYS, type DashboardRange } from '@/components/DashboardFilter';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { UsageOverview } from '../components/UsageOverview';
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

  return (
    <section aria-labelledby="my-usage-heading">
      <header className="border-b border-black/6 p-3 dark:border-white/6">
        <h1 id="my-usage-heading" className="text-[18px]/6 font-semibold text-foreground">我的用量</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Segmented label="时间范围" options={ranges} value={range} onChange={setRange} />
          {authStatus === 'authenticated' && <UsageActions />}
        </div>
      </header>
      {authStatus === 'authenticated' ? (
        <UsageOverview days={DASHBOARD_RANGE_DAYS[range]} />
      ) : (
        <UsageLoginGate checking={authStatus === 'loading'} />
      )}
    </section>
  );
}

export const Route = createFileRoute('/dashboard')({ component: MyUsagePage });

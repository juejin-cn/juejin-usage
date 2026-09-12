import { Card, Skeleton } from '@heroui/react';

/** Compact chart-card placeholder used while staggered reveal catches up. */
export function DashboardChartSlotSkeleton() {
  return (
    <Card aria-hidden="true" className="min-w-0 overflow-hidden rounded-2xl">
      <Card.Header className="flex-row items-start justify-between gap-3 pb-0">
        <div className="space-y-2">
          <Skeleton className="h-5 w-28 rounded-md" />
          <Skeleton className="h-3 w-44 rounded-md" />
        </div>
        <Skeleton className="h-6 w-20 rounded-lg" />
      </Card.Header>
      <Card.Content className="pt-4">
        <Skeleton className="h-52 w-full rounded-xl" />
      </Card.Content>
    </Card>
  );
}

/** Overview (metrics + heatmap) placeholder for staggered reveal. */
export function DashboardOverviewSlotSkeleton() {
  return (
    <div aria-hidden="true" className="w-full">
      <section className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card className="h-[5.5rem] min-h-[5.5rem] min-w-0 overflow-hidden rounded-2xl p-3" key={index}>
            <Card.Content className="grid grid-rows-[auto_auto] gap-4 p-0">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3 w-16 rounded-md" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_64px] items-end gap-2">
                <Skeleton className="h-7 w-24 rounded-md" />
                <Skeleton className="h-6 w-16 justify-self-end rounded-md" />
              </div>
            </Card.Content>
          </Card>
        ))}
      </section>
      <div className="mt-4 rounded-2xl border border-border/60 bg-surface p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-6 w-20 rounded-lg" />
        </div>
        <Skeleton className="h-36 w-full rounded-xl sm:h-44" />
      </div>
    </div>
  );
}

/** Layout-stable placeholder for the dashboard's initial data request. */
export function DashboardLoadingSkeleton() {
  return (
    <div aria-label="用量数据加载中" className="w-full" role="status">
      <DashboardOverviewSlotSkeleton />

      <section aria-hidden="true" className="mt-4 grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 5 }, (_, index) => (
          <DashboardChartSlotSkeleton key={index} />
        ))}
      </section>
    </div>
  );
}

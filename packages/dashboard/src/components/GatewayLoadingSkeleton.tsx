import { Card, Skeleton } from '@heroui/react';

export function GatewayLoadingSkeleton() {
  return <div role="status" aria-label="正在加载网关" className="gateway-loading grid grid-cols-3 gap-2.5">
    {Array.from({ length: 3 }, (_, index) => <Card key={index} aria-hidden="true" className="min-w-0 overflow-hidden rounded-2xl px-3 pb-3 pt-2">
      <Card.Content className="grid gap-2 p-0">
        <div className="flex h-7 items-center gap-2">
          <Skeleton className="size-4.5 shrink-0 rounded-md" />
          <Skeleton className="h-3 w-20 max-w-full rounded-md" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
      </Card.Content>
    </Card>)}
  </div>;
}

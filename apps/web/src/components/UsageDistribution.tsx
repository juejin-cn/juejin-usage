import type { DashboardDistributionRow } from '@/lib/dashboard-mock-data';
import { CompositionBar, CompositionTable } from './UsageComposition';

export function UsageDistribution({ category, rows }: {
  category: '工具' | '模型';
  rows: readonly DashboardDistributionRow[];
}) {
  const title = `${category}分布`;
  const parts = rows.filter(row => row.tokens > 0).map(row => ({
    key: row.label,
    label: row.label,
    count: row.tokens,
    color: row.color,
  }));
  const total = parts.reduce((sum, part) => sum + part.count, 0);

  return (
    <section aria-label={title} className="min-w-0 p-3">
      <h3 className="text-base font-semibold">{title}</h3>
      {total > 0 ? (
        <>
          <CompositionBar total={total} segments={parts} />
          <CompositionTable ariaLabel={title} categoryLabel={category} quantityLabel="Token"
            rows={parts} total={total} hasShares />
        </>
      ) : (
        <p className="py-8 text-center text-sm text-muted">当前周期暂无{category}用量</p>
      )}
    </section>
  );
}

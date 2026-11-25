import { memo, useEffect, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { ModelProviderIcon } from '@/components/ModelProviderIcon';
import type { PricingCatalogRow } from '@/lib/api';
import { getModelProvider } from '@/lib/model-provider';
import { getPricingModelName } from '@/lib/pricing-catalog';
import { formatPricingUsd, isFreePricingRow } from '@web/lib/pricing-view';
import { cn } from '@web/lib/utils';

function CopyModelIdButton({ modelId }: { modelId: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopied(true);
    } catch {
      // Clipboard API may be blocked in non-secure contexts.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={copied ? `已复制 ${modelId}` : `复制模型 ID ${modelId}`}
      title={copied ? '已复制' : '复制模型 ID'}
      className={cn(
        'inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-muted/65 hover:bg-surface-secondary hover:text-foreground',
      )}
    >
      {copied ? (
        <IconCheck size={13} aria-hidden="true" />
      ) : (
        <IconCopy size={13} aria-hidden="true" />
      )}
    </button>
  );
}

function hasPositivePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function PriceValue({
  value,
  primary = false,
}: {
  value: number;
  primary?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline whitespace-nowrap text-sm tabular-nums">
      <span
        className={cn(
          'text-emerald-600 dark:text-emerald-400',
          primary ? 'font-semibold' : 'font-medium',
        )}
      >
        {formatPricingUsd(value)}
      </span>
      <span className="ml-0.5 font-normal text-muted">/1M</span>
    </span>
  );
}

export const PricingModelCard = memo(function PricingModelCard({
  row,
  className,
}: {
  row: PricingCatalogRow;
  className?: string;
}) {
  const provider = getModelProvider(row.model);
  const modelName = getPricingModelName(row.model);
  const isFree = isFreePricingRow(row);
  const priceItems = [
    ...(hasPositivePrice(row.input) || isFree
      ? [{ label: '输入', value: row.input, primary: true }]
      : []),
    ...(hasPositivePrice(row.output) || isFree
      ? [{ label: '输出', value: row.output, primary: true }]
      : []),
    ...(hasPositivePrice(row.cacheRead)
      ? [{ label: '缓存读', value: row.cacheRead, primary: false }]
      : []),
    ...(hasPositivePrice(row.cacheWrite)
      ? [{ label: '缓存写', value: row.cacheWrite, primary: false }]
      : []),
  ];

  return (
    <article
      className={cn(
        'group flex min-w-0 flex-col justify-between p-4 transition-colors hover:bg-[#fafafa] dark:hover:bg-white/[0.025]',
        className,
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ModelProviderIcon fallbackText={modelName} provider={provider} size={32} />
          <div className="min-w-0 flex-1">
            <h2
              className="truncate text-base/6 font-semibold tracking-[-0.01em] text-foreground"
              title={modelName}
            >
              {modelName}
            </h2>
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[13px]/5 text-muted">
              <span className="truncate font-code" title={row.model}>
                {row.model}
              </span>
              <CopyModelIdButton modelId={row.model} />
            </div>
          </div>
        </div>
        {isFree && (
          <span className="shrink-0 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-xs/4 font-semibold text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
            免费
          </span>
        )}
      </div>

      {priceItems.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-sm/5">
          {priceItems.map((item) => (
            <div key={item.label} className="flex min-w-0 items-baseline gap-1.5">
              <dt className="shrink-0 text-sm text-muted">{item.label}</dt>
              <dd className="min-w-0">
                <PriceValue value={item.value} primary={item.primary} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
});

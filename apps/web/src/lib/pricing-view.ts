import type { PricingCatalogRow } from '@/lib/api';
import { getModelProvider, type ModelProvider } from '@/lib/model-provider';
import { getPricingModelName } from '@/lib/pricing-catalog';

export type PricingViewSortKey =
  | 'input:desc'
  | 'input:asc'
  | 'output:desc'
  | 'output:asc'
  | 'cache:desc'
  | 'cache:asc'
  | 'model:asc'
  | 'model:desc';

export interface PricingSortOption {
  key: PricingViewSortKey;
  label: string;
  shortLabel: string;
}

export const DEFAULT_PRICING_VIEW_SORT: PricingViewSortKey = 'input:desc';

export const PRICING_SORT_OPTIONS: readonly PricingSortOption[] = [
  { key: 'input:desc', label: '输入价格：从高到低', shortLabel: '输入价降序' },
  { key: 'input:asc', label: '输入价格：从低到高', shortLabel: '输入价升序' },
  { key: 'output:desc', label: '输出价格：从高到低', shortLabel: '输出价降序' },
  { key: 'output:asc', label: '输出价格：从低到高', shortLabel: '输出价升序' },
  { key: 'cache:desc', label: '缓存读：从高到低', shortLabel: '缓存价降序' },
  { key: 'cache:asc', label: '缓存读：从低到高', shortLabel: '缓存价升序' },
  { key: 'model:asc', label: '模型名称：A → Z', shortLabel: '名称 A-Z' },
  { key: 'model:desc', label: '模型名称：Z → A', shortLabel: '名称 Z-A' },
];

export interface PricingProviderOption extends ModelProvider {
  count: number;
}

const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatPricingUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  return `$${priceFormatter.format(value)}`;
}

export function isFreePricingRow(row: PricingCatalogRow): boolean {
  return row.input <= 0 && row.output <= 0;
}

export function getProviderOptionKey(provider: ModelProvider): string {
  return `${provider.icon}:${provider.label.toLocaleLowerCase()}`;
}

export function buildProviderOptions(rows: readonly PricingCatalogRow[]): PricingProviderOption[] {
  const providers = new Map<string, PricingProviderOption>();
  for (const row of rows) {
    const provider = getModelProvider(row.model);
    const optionKey = getProviderOptionKey(provider);
    const existing = providers.get(optionKey);
    if (existing) {
      existing.count += 1;
    } else {
      providers.set(optionKey, { ...provider, key: optionKey, count: 1 });
    }
  }
  return [...providers.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function comparePositiveFirstAsc(a: number, b: number): number {
  const aValid = a > 0;
  const bValid = b > 0;
  if (aValid !== bValid) return aValid ? -1 : 1;
  return a - b;
}

export function filterAndSortPricingRows(
  rows: readonly PricingCatalogRow[],
  options: {
    query: string;
    providerKey: string;
    sort: PricingViewSortKey;
  },
): PricingCatalogRow[] {
  const normalizedQuery = options.query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    const provider = getModelProvider(row.model);
    if (options.providerKey && getProviderOptionKey(provider) !== options.providerKey) {
      return false;
    }
    if (!normalizedQuery) return true;
    return (
      row.model.toLocaleLowerCase().includes(normalizedQuery)
      || provider.label.toLocaleLowerCase().includes(normalizedQuery)
    );
  });

  return [...filtered].sort((a, b) => {
    let primary = 0;
    let secondary = 0;

    switch (options.sort) {
      case 'input:desc':
        primary = b.input - a.input;
        secondary = b.output - a.output;
        break;
      case 'input:asc':
        primary = a.input - b.input;
        secondary = a.output - b.output;
        break;
      case 'output:desc':
        primary = b.output - a.output;
        secondary = b.input - a.input;
        break;
      case 'output:asc':
        primary = a.output - b.output;
        secondary = a.input - b.input;
        break;
      case 'cache:desc':
        primary = b.cacheRead - a.cacheRead;
        secondary = b.cacheWrite - a.cacheWrite;
        break;
      case 'cache:asc':
        primary = comparePositiveFirstAsc(a.cacheRead, b.cacheRead);
        secondary = comparePositiveFirstAsc(a.cacheWrite, b.cacheWrite);
        break;
      case 'model:asc':
        primary = getPricingModelName(a.model).localeCompare(getPricingModelName(b.model));
        break;
      case 'model:desc':
        primary = getPricingModelName(b.model).localeCompare(getPricingModelName(a.model));
        break;
    }

    if (primary !== 0) return primary;
    if (secondary !== 0) return secondary;
    return a.model.localeCompare(b.model);
  });
}

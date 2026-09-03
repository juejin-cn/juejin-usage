import type { LeaderboardMetric, LeaderboardRange } from '@/lib/api';
import { getModelProvider, type ModelProvider } from './model-provider.ts';

export type RankRange = LeaderboardRange;

export const RANK_RANGES = ['today', 'week', 'month', 'all'] as const;

export function isRankRange(value: unknown): value is RankRange {
  return (
    typeof value === 'string' &&
    (RANK_RANGES as readonly string[]).includes(value)
  );
}

export interface RankModelOption {
  tool: string;
  model: string;
}

const PRIORITY_RANK_MODEL_VENDORS = [
  { key: 'anthropic', label: 'Anthropic', icon: 'claude' },
  { key: 'openai', label: 'OpenAI', icon: 'openai' },
  { key: 'google', label: 'Google', icon: 'google' },
  { key: 'alibaba', label: '阿里', icon: 'alibaba' },
  { key: 'moonshot', label: 'Moonshot', icon: 'moonshot' },
  { key: 'doubao', label: 'Doubao', icon: 'doubao' },
  { key: 'minimax', label: 'MiniMax', icon: 'minimax' },
  { key: 'xai', label: 'xAI', icon: 'grok' },
  { key: 'deepseek', label: 'DeepSeek', icon: 'deepseek' },
  { key: 'zhipu', label: 'Zhipu', icon: 'zhipu' },
] as const;

export type RankModelVendorKey = string;

export interface RankModelVendorGroup {
  key: RankModelVendorKey;
  label: string;
  icon: string;
  models: string[];
}

const RANK_VENDOR_KEYS: Record<string, RankModelVendorKey> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  codex: 'openai',
  openai: 'openai',
  gemini: 'google',
  google: 'google',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  kimi: 'moonshot',
  moonshot: 'moonshot',
  grok: 'xai',
  xai: 'xai',
  deepseek: 'deepseek',
  zai: 'zhipu',
  zhipu: 'zhipu',
};

const PRIORITY_VENDOR_INDEX = new Map<string, number>(
  PRIORITY_RANK_MODEL_VENDORS.map((vendor, index) => [vendor.key, index]),
);

function rankVendorForProvider(
  provider: ModelProvider,
): Omit<RankModelVendorGroup, 'models'> {
  const key = RANK_VENDOR_KEYS[provider.key] ?? provider.key;
  const priorityVendor = PRIORITY_RANK_MODEL_VENDORS.find(
    (vendor) => vendor.key === key,
  );
  if (priorityVendor) return priorityVendor;
  if (key === 'unknown') return { key: 'other', label: '其他', icon: 'unknown' };
  return { key, label: provider.label, icon: provider.icon };
}

function compareRankVendors(
  a: RankModelVendorGroup,
  b: RankModelVendorGroup,
): number {
  if (a.key === 'other') return 1;
  if (b.key === 'other') return -1;
  const aPriority = PRIORITY_VENDOR_INDEX.get(a.key);
  const bPriority = PRIORITY_VENDOR_INDEX.get(b.key);
  if (aPriority !== undefined || bPriority !== undefined) {
    return (
      (aPriority ?? Number.MAX_SAFE_INTEGER) -
      (bPriority ?? Number.MAX_SAFE_INTEGER)
    );
  }
  return a.label.localeCompare(b.label);
}

/** 按识别出的模型厂商动态分组，合并同厂商模型族，并支持厂商与模型名模糊搜索。 */
export function groupRankModelsByVendor(
  models: readonly string[],
  query = '',
): RankModelVendorGroup[] {
  const buckets = new Map<RankModelVendorKey, RankModelVendorGroup>();
  buckets.set('other', {
    key: 'other',
    label: '其他',
    icon: 'unknown',
    models: [],
  });

  for (const model of new Set(models.filter(Boolean))) {
    const provider = getModelProvider(model);
    const vendor = rankVendorForProvider(provider);
    const group = buckets.get(vendor.key) ?? { ...vendor, models: [] };
    group.models.push(model);
    buckets.set(vendor.key, group);
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...buckets.values()]
    .flatMap((group) => {
      const vendorMatches = group.label
        .toLocaleLowerCase()
        .includes(normalizedQuery);
      const filteredModels =
        normalizedQuery && !vendorMatches
          ? group.models.filter((model) =>
              `${group.label} ${model}`
                .toLocaleLowerCase()
                .includes(normalizedQuery),
            )
          : group.models;

      if (
        filteredModels.length === 0 &&
        !(group.key === 'other' && (!normalizedQuery || vendorMatches))
      ) {
        return [];
      }
      return [
        {
          ...group,
          models: filteredModels.sort((a, b) => a.localeCompare(b)),
        },
      ];
    })
    .sort(compareRankVendors);
}

/**
 * Return the model options that can be rendered by a single Select collection.
 *
 * The API stores tool/model pairs, so a model used by more than one tool can
 * occur more than once when no tool is selected. HeroUI's ListBox is keyed by
 * the option id (the model name in RankFilter), and duplicate ids corrupt
 * React Aria's collection when the options change asynchronously.
 */
export function uniqueRankModelOptions(
  options: readonly RankModelOption[],
  tool = '',
): RankModelOption[] {
  const seen = new Set<string>();
  const result: RankModelOption[] = [];

  for (const option of options) {
    if (tool && option.tool !== tool) continue;
    if (!option.model || seen.has(option.model)) continue;
    seen.add(option.model);
    result.push(option);
  }

  return result;
}

export function formatRankPosition(rank: number | null | undefined): string {
  if (rank === null || rank === undefined || !Number.isFinite(rank) || rank < 1) {
    return '—';
  }
  return rank > 99 ? '> 99' : String(Math.floor(rank));
}

export function leaderboardMetricLabel(metric: LeaderboardMetric): string {
  return metric === 'cost' ? '按消费' : '按 Token';
}

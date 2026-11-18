import type {
  LeaderboardMetric,
  ModelLeaderboardRange,
  ModelLeaderboardBoard,
  ModelLeaderboardOverviewResponse,
  ModelLeaderboardTrendPoint,
} from '@juejin-opensource/jusage-core';

const MODELS = [
  'claude-opus-4-6', 'gpt-6', 'gemini-3.5-pro', 'deepseek-v4', 'glm-5.3',
  'claude-sonnet-4-6', 'qwen3.5-coder', 'gpt-5.4', 'kimi-k2.7', 'minimax-m2.5',
  'gemini-3-flash', 'deepseek-v3.2', 'grok-4.1', 'claude-haiku-4-5', 'qwen3-coder',
  'gpt-5.3-codex', 'glm-5.2', 'kimi-k2', 'mistral-large', 'doubao-seed',
  'gemini-2.5-pro', 'llama-4', 'gpt-5', 'claude-sonnet-4-5',
] as const;

const TOOLS = [
  { key: 'codex', displayName: 'Codex' },
  { key: 'claude-code', displayName: 'Claude Code' },
  { key: 'cursor', displayName: 'Cursor' },
] as const;

export function createMockModelLeaderboardOverview(
  range: ModelLeaderboardRange,
): ModelLeaderboardOverviewResponse {
  const scale = { today: 0.04, week: 1, month: 3.8 }[range];
  const entries = MODELS.map((model, index) => ({
    model,
    tool: TOOLS[index % TOOLS.length]!.key,
    tokens: Math.round((3_200_000_000 / (1 + index * 0.18)) * scale),
    costUsd: Math.round((8_000 / (1 + index * 0.27)) * scale * (0.5 + (index % 4) * 0.3) * 100) / 100,
  }));
  const totalTokens = entries.reduce((sum, item) => sum + item.tokens, 0);
  const totalCostUsd = entries.reduce((sum, item) => sum + item.costUsd, 0);
  const buckets = range === 'today' ? 15 : range === 'week' ? 7 : 30;
  const board = (metric: LeaderboardMetric): ModelLeaderboardBoard => {
    const sorted = [...entries].sort((a, b) =>
      (metric === 'tokens' ? b.tokens - a.tokens : b.costUsd - a.costUsd) ||
      a.model.localeCompare(b.model),
    );
    const rows = sorted.map((item, index) => ({ ...item, rank: index + 1 }))
      .slice(0, 20)
      .map((item) => {
        const amount = metric === 'tokens' ? item.tokens : item.costUsd;
        const denominator = metric === 'tokens' ? totalTokens : totalCostUsd;
        const trend: ModelLeaderboardTrendPoint[] = Array.from({ length: buckets }, (_, index) => {
          const wave = 0.6 + index / (buckets * 2) + ((index * 7 + item.rank) % 5) / 20;
          return {
            bucket: String(index + 1),
            tokens: Math.round((item.tokens / buckets) * wave),
            costUsd: Math.round((item.costUsd / buckets) * wave * 100) / 100,
          };
        });
        const previousTrend: ModelLeaderboardTrendPoint[] = trend.map((point, index) => ({
          ...point,
          bucket: `previous-${point.bucket}`,
          tokens: Math.round(point.tokens * (0.8 + ((index + item.rank) % 4) * 0.1)),
          costUsd: Math.round(point.costUsd * (0.8 + ((index + item.rank) % 4) * 0.1) * 100) / 100,
        }));
        return {
          rank: item.rank,
          model: item.model,
          tools: [item.tool],
          tokens: item.tokens,
          costUsd: item.costUsd,
          share: denominator ? Math.round((amount / denominator) * 10_000) / 100 : 0,
          previousValue: Math.round(amount * (0.75 + (item.rank % 4) * 0.1)),
          changePct: Math.round((1 / (0.75 + (item.rank % 4) * 0.1) - 1) * 1000) / 10,
          trend,
          previousTrend,
        };
      });
    return { metric, totalModels: entries.length, totalTokens, totalCostUsd, rows };
  };
  return {
    range,
    limit: 20,
    generatedAt: new Date().toISOString(),
    boards: { tokens: board('tokens'), cost: board('cost') },
  };
}

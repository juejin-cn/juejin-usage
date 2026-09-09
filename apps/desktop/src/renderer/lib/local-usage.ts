import {
  emptyLocalMetrics,
  mergeLocalMetrics,
  type LocalUsageMetrics,
} from '@juejin-opensource/jusage-core/local-metrics';

export function unavailableLocalMetrics(): LocalUsageMetrics {
  return {
    ...emptyLocalMetrics(),
    requestCount: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    missingReasons: ['legacy_data'],
  };
}

/** Numeric compatibility fields; nullable evidence remains authoritative for UI. */
export function localUsageFields(metrics: LocalUsageMetrics) {
  return {
    localMetrics: metrics,
    inputTokens:
      metrics.cacheReadTokens === null || metrics.cacheWriteTokens === null
        ? 0
        : metrics.uncachedInputTokens +
          metrics.cacheReadTokens +
          metrics.cacheWriteTokens,
    uncachedInputTokens: metrics.uncachedInputTokens,
    cachedInputTokens: metrics.cacheReadTokens ?? 0,
    outputTokens: metrics.outputTokens + metrics.reasoningOutputTokens,
  };
}

export function sumLocalMetrics(
  rows: readonly { localMetrics?: LocalUsageMetrics }[],
) {
  return mergeLocalMetrics(
    rows.map((row) => row.localMetrics ?? unavailableLocalMetrics()),
  );
}

export function localChartFields(metrics: LocalUsageMetrics) {
  return {
    input:
      metrics.cacheReadTokens === null || metrics.cacheWriteTokens === null
        ? null
        : metrics.uncachedInputTokens,
    output: metrics.outputTokens + metrics.reasoningOutputTokens,
    cache: metrics.cacheReadTokens,
    creation: metrics.cacheWriteTokens,
  };
}

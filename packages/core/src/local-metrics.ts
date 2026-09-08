import type { QueueBucket } from './types.js';

export type LocalMetricMissingReason =
  | 'legacy_data'
  | 'unsupported_source'
  | 'missing_fields'
  | 'ambiguous_request'
  | 'invalid_usage';

/** Local-only evidence. Never included in the upload contract. */
export interface LocalMetricEvidence {
  version: 1;
  requestCount: number;
  requestCountComplete: boolean;
  cacheReadComplete: boolean;
  cacheWriteComplete: boolean;
  missingReasons: LocalMetricMissingReason[];
}

export interface LocalUsageMetrics {
  version: 1;
  uncachedInputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  requestCount: number | null;
  knownRequestCount: number;
  cacheHitRate: number | null;
  missingReasons: LocalMetricMissingReason[];
}

export function localEvidence(
  requestCount: number,
  requestCountComplete = true,
  cacheReadComplete = true,
  cacheWriteComplete = true,
): LocalMetricEvidence {
  return {
    version: 1,
    requestCount,
    requestCountComplete,
    cacheReadComplete,
    cacheWriteComplete,
    missingReasons: [
      ...(!requestCountComplete ? ['ambiguous_request' as const] : []),
      ...(!cacheReadComplete || !cacheWriteComplete
        ? ['missing_fields' as const]
        : []),
    ],
  };
}

/** Missing optional cache fields mean zero only in the explicitly adapted formats. */
export function validUsageFields(
  required: unknown[],
  optional: unknown[] = [],
): boolean {
  const valid = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return (
    required.every(valid) &&
    optional.every((value) => value === undefined || valid(value))
  );
}

export function mergeLocalEvidence(
  a: LocalMetricEvidence | undefined,
  b: LocalMetricEvidence | undefined,
): LocalMetricEvidence {
  return {
    version: 1,
    requestCount: (a?.requestCount ?? 0) + (b?.requestCount ?? 0),
    requestCountComplete:
      !!a?.requestCountComplete && !!b?.requestCountComplete,
    cacheReadComplete: !!a?.cacheReadComplete && !!b?.cacheReadComplete,
    cacheWriteComplete: !!a?.cacheWriteComplete && !!b?.cacheWriteComplete,
    missingReasons: [
      ...new Set([
        ...(a?.missingReasons ?? ['legacy_data' as const]),
        ...(b?.missingReasons ?? ['legacy_data' as const]),
      ]),
    ].sort(),
  };
}

export function emptyLocalMetrics(): LocalUsageMetrics {
  return {
    version: 1,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    requestCount: 0,
    knownRequestCount: 0,
    cacheHitRate: null,
    missingReasons: [],
  };
}

const LEGACY_CACHE_SOURCES = new Set(['claude', 'codex', 'cursor', 'opencode']);

/** The historical parsers for these sources already store disjoint cache fields. */
export function metricsFromBucket(row: QueueBucket): LocalUsageMetrics {
  if (
    row.total_tokens === 0 &&
    row.conversation_count === 0 &&
    !row.local_metrics?.requestCount
  ) {
    return emptyLocalMetrics();
  }
  const evidence =
    row.local_metrics?.version === 1 ? row.local_metrics : undefined;
  const countValid =
    evidence &&
    Number.isSafeInteger(evidence.requestCount) &&
    evidence.requestCount >= 0;
  const safeToken = (n: number) => (Number.isFinite(n) && n >= 0 ? n : 0);
  const valid = [
    row.input_tokens,
    row.output_tokens,
    row.cached_input_tokens,
    row.cache_creation_input_tokens,
    row.reasoning_output_tokens,
  ].every((n) => Number.isFinite(n) && n >= 0);
  const legacyCache = LEGACY_CACHE_SOURCES.has(row.source);
  const readKnown =
    valid && (evidence ? evidence.cacheReadComplete : legacyCache);
  const writeKnown =
    valid && (evidence ? evidence.cacheWriteComplete : legacyCache);
  const result: LocalUsageMetrics = {
    version: 1,
    uncachedInputTokens: safeToken(row.input_tokens),
    cacheReadTokens: readKnown ? row.cached_input_tokens : null,
    cacheWriteTokens: writeKnown ? row.cache_creation_input_tokens : null,
    outputTokens: safeToken(row.output_tokens),
    reasoningOutputTokens: safeToken(row.reasoning_output_tokens),
    requestCount:
      countValid && evidence.requestCountComplete
        ? evidence.requestCount
        : null,
    knownRequestCount: countValid ? evidence.requestCount : 0,
    cacheHitRate: null,
    missingReasons: [
      ...new Set<LocalMetricMissingReason>([
        ...(evidence?.missingReasons ?? [
          legacyCache ? 'legacy_data' : 'unsupported_source',
        ]),
        ...(!valid || (evidence && !countValid)
          ? ['invalid_usage' as const]
          : []),
      ]),
    ].sort(),
  };
  result.cacheHitRate = cacheHitRate(result);
  return result;
}

function nullableSum(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export function cacheHitRate(
  metrics: Pick<
    LocalUsageMetrics,
    'uncachedInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
  >,
): number | null {
  const { uncachedInputTokens, cacheReadTokens, cacheWriteTokens } = metrics;
  if (cacheReadTokens === null || cacheWriteTokens === null) return null;
  const input = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  return input > 0 ? cacheReadTokens / input : null;
}

/** Browser-safe aggregation: sum raw amounts before calculating the ratio. */
export function mergeLocalMetrics(
  parts: readonly LocalUsageMetrics[],
): LocalUsageMetrics {
  const result = emptyLocalMetrics();
  for (const part of parts) {
    result.uncachedInputTokens += part.uncachedInputTokens;
    result.cacheReadTokens = nullableSum(
      result.cacheReadTokens,
      part.cacheReadTokens,
    );
    result.cacheWriteTokens = nullableSum(
      result.cacheWriteTokens,
      part.cacheWriteTokens,
    );
    result.outputTokens += part.outputTokens;
    result.reasoningOutputTokens += part.reasoningOutputTokens;
    result.requestCount = nullableSum(result.requestCount, part.requestCount);
    result.knownRequestCount += part.knownRequestCount;
    result.missingReasons.push(...part.missingReasons);
  }
  result.missingReasons = [...new Set(result.missingReasons)].sort();
  result.cacheHitRate = cacheHitRate(result);
  return result;
}

export function aggregateLocalMetrics(
  rows: readonly QueueBucket[],
): LocalUsageMetrics {
  return mergeLocalMetrics(rows.map(metricsFromBucket));
}

import { mergeLocalEvidence, localEvidence } from '../local-metrics.js';
import type { QueueBucket } from '../types.js';

export const UNKNOWN_MODEL = 'unknown';

export function unknownAlignGroupKey(row: {
  source: string;
  project: string;
  hour_start: string;
  collector?: string;
}): string {
  const collector = row.collector?.trim() || '';
  return `${row.source}|${collector}|${row.project}|${row.hour_start}`;
}

function addBucketTotals(a: QueueBucket, b: QueueBucket): QueueBucket {
  return {
    ...a,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    reasoning_output_tokens:
      a.reasoning_output_tokens + b.reasoning_output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    conversation_count: a.conversation_count + b.conversation_count,
    ...(a.local_metrics || b.local_metrics
      ? { local_metrics: mergeLocalEvidence(a.local_metrics, b.local_metrics) }
      : {}),
    ...(a.reported_cost_usd != null || b.reported_cost_usd != null
      ? {
          reported_cost_usd:
            (a.reported_cost_usd ?? 0) + (b.reported_cost_usd ?? 0),
        }
      : {}),
  };
}

function zeroBucket(row: QueueBucket): QueueBucket {
  return {
    ...row,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    conversation_count: 0,
    ...(row.local_metrics ? { local_metrics: localEvidence(0) } : {}),
    ...(row.reported_cost_usd != null ? { reported_cost_usd: 0 } : {}),
  };
}

function pickDominant(known: QueueBucket[]): QueueBucket {
  let dominant = known[0]!;
  for (const row of known) {
    if (
      row.total_tokens > dominant.total_tokens ||
      (row.total_tokens === dominant.total_tokens && row.model < dominant.model)
    ) {
      dominant = row;
    }
  }
  return dominant;
}

export function collectCodexDominantModels(
  buckets: QueueBucket[],
): { hourStart: string; model: string }[] {
  const byHour = new Map<string, Map<string, number>>();
  for (const row of buckets) {
    if (row.source !== 'codex' || row.model === UNKNOWN_MODEL) continue;
    let models = byHour.get(row.hour_start);
    if (!models) {
      models = new Map();
      byHour.set(row.hour_start, models);
    }
    models.set(row.model, (models.get(row.model) ?? 0) + row.total_tokens);
  }

  const dominants: { hourStart: string; model: string }[] = [];
  for (const [hourStart, models] of byHour.entries()) {
    let model: string | null = null;
    let total = -1;
    for (const [name, tokens] of models.entries()) {
      if (model == null || tokens > total || (tokens === total && name < model)) {
        model = name;
        total = tokens;
      }
    }
    if (model) dominants.push({ hourStart, model });
  }
  return dominants;
}

export function findNearestCodexModel(
  hourStart: string,
  dominants: { hourStart: string; model: string }[],
): string | null {
  const target = Date.parse(hourStart);
  if (!Number.isFinite(target) || dominants.length === 0) return null;

  let best: { diff: number; time: number; model: string } | null = null;
  for (const entry of dominants) {
    const candidate = Date.parse(entry.hourStart);
    if (!Number.isFinite(candidate)) continue;
    const diff = Math.abs(candidate - target);
    if (!best || diff < best.diff || (diff === best.diff && candidate < best.time)) {
      best = { diff, time: candidate, model: entry.model };
    }
  }
  return best?.model ?? null;
}

function retargetUnknown(
  group: QueueBucket[],
  unknownRows: QueueBucket[],
  target: QueueBucket,
  retractUnknown: boolean,
): QueueBucket[] {
  let unknownSum: QueueBucket | null = null;
  for (const row of unknownRows) {
    unknownSum = unknownSum ? addBucketTotals(unknownSum, row) : { ...row };
  }
  if (!unknownSum) return group;

  const out: QueueBucket[] = [];
  let mergedTarget = false;
  for (const row of group) {
    if (row.model === UNKNOWN_MODEL) {
      if (retractUnknown) out.push(zeroBucket(row));
      continue;
    }
    if (row === target) {
      out.push(addBucketTotals(row, unknownSum));
      mergedTarget = true;
      continue;
    }
    out.push(row);
  }
  if (!mergedTarget) {
    out.push({
      ...unknownSum,
      model: target.model,
    });
  }
  return out;
}

/**
 * Same-hour unknown → dominant known model (if any). Every Code hours that
 * only have unknown borrow the nearest Codex hour's dominant model.
 *
 * `retractUnknown` keeps a zeroed unknown row so append-only queue latest-wins
 * can hide a previously written unknown bucket.
 * `contextBuckets` supplies Codex hours when aligning Every Code in isolation.
 */
export function alignUnknownIntoDominant(
  buckets: QueueBucket[],
  options?: { retractUnknown?: boolean; contextBuckets?: QueueBucket[] },
): QueueBucket[] {
  const retractUnknown = options?.retractUnknown === true;
  const codexDominants = collectCodexDominantModels(
    options?.contextBuckets ?? buckets,
  );

  const groups = new Map<string, QueueBucket[]>();
  for (const bucket of buckets) {
    const key = unknownAlignGroupKey(bucket);
    const list = groups.get(key);
    if (list) list.push(bucket);
    else groups.set(key, [bucket]);
  }

  const out: QueueBucket[] = [];
  for (const group of groups.values()) {
    const unknownRows = group.filter((row) => row.model === UNKNOWN_MODEL);
    const knownRows = group.filter((row) => row.model !== UNKNOWN_MODEL);
    const unknownHasUsage = unknownRows.some(
      (row) => row.total_tokens > 0 || row.conversation_count > 0,
    );

    if (!unknownHasUsage) {
      out.push(...group);
      continue;
    }

    if (knownRows.length > 0) {
      out.push(...retargetUnknown(group, unknownRows, pickDominant(knownRows), retractUnknown));
      continue;
    }

    const source = group[0]?.source;
    const hourStart = group[0]?.hour_start;
    if (source === 'every-code' && hourStart) {
      const nearest = findNearestCodexModel(hourStart, codexDominants);
      if (nearest) {
        const target: QueueBucket = { ...unknownRows[0]!, model: nearest };
        out.push(...retargetUnknown(group, unknownRows, target, retractUnknown));
        continue;
      }
    }

    out.push(...group);
  }
  return out;
}

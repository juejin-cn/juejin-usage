/** Account-scoped presentation metadata. Never used to select a route or bill a call. */
export interface ModelMetadata {
  name?: string;
  capabilities?: { vision?: boolean; reasoning?: boolean; toolCalling?: boolean };
  limits?: { contextTokens?: number; maxContextTokens?: number; outputTokens?: number };
  billing?: { isFree?: boolean; multiplier?: number; originalMultiplier?: number; discountRatio?: number; conditions?: string[]; validUntil?: string };
}
export interface ModelCatalog {
  models: string[];
  names?: Record<string, string>;
  metadata?: Record<string, ModelMetadata>;
  checkedAt?: string;
}

export function metadataNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f<>]/.test(v);

/** Whitelist fields at every catalog boundary; malformed optional fields don't hide a model. */
export function sanitizeModelMetadata(value: unknown): ModelMetadata {
  const raw = object(value); const out: ModelMetadata = {};
  if (text(raw.name, 200)) out.name = raw.name.trim();
  const caps = object(raw.capabilities); const capabilities: NonNullable<ModelMetadata['capabilities']> = {};
  for (const key of ['vision', 'reasoning', 'toolCalling'] as const) if (typeof caps[key] === 'boolean') capabilities[key] = caps[key];
  if (Object.keys(capabilities).length) out.capabilities = capabilities;
  const limits: NonNullable<ModelMetadata['limits']> = {}; const input = object(raw.limits);
  for (const key of ['contextTokens', 'maxContextTokens', 'outputTokens'] as const) {
    const n = metadataNumber(input[key]);
    if (n !== undefined && Number.isSafeInteger(n) && n > 0) limits[key] = n;
  }
  if (limits.maxContextTokens && limits.contextTokens && limits.maxContextTokens <= limits.contextTokens) delete limits.maxContextTokens;
  if (Object.keys(limits).length) out.limits = limits;
  const billing: NonNullable<ModelMetadata['billing']> = {}; const b = object(raw.billing);
  if (typeof b.isFree === 'boolean') billing.isFree = b.isFree;
  for (const key of ['multiplier', 'originalMultiplier', 'discountRatio'] as const) {
    const n = metadataNumber(b[key]);
    if (n !== undefined && (key !== 'discountRatio' || n <= 1)) billing[key] = n;
  }
  if (Array.isArray(b.conditions)) {
    const conditions = b.conditions.filter((v): v is string => text(v, 200)).slice(0, 8);
    if (conditions.length) billing.conditions = conditions;
  }
  if (typeof b.validUntil === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(b.validUntil) && Number.isFinite(Date.parse(b.validUntil))) billing.validUntil = new Date(b.validUntil).toISOString();
  if (Object.keys(billing).length) out.billing = billing;
  return out;
}

export function buildModelCatalog(rows: Record<string, ModelMetadata>, maximum = 4096): ModelCatalog {
  const models = Object.keys(rows).filter(id => !!id.trim() && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id)).slice(0, maximum);
  const metadata = Object.fromEntries(models.map(id => [id, sanitizeModelMetadata(rows[id])]));
  const names = Object.fromEntries(models.flatMap(id => metadata[id].name ? [[id, metadata[id].name!]] : []));
  return { models, names, metadata, checkedAt: new Date().toISOString() };
}

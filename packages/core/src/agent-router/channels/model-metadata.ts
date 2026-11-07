import { metadataNumber as n, sanitizeModelMetadata, type ModelMetadata } from '../model-metadata.js';
import type { Json } from './http.js';

const bool = (v: unknown) => typeof v === 'boolean' ? v : undefined;
const modalities = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string') ? v.some(x => x.toLowerCase() === 'image') : undefined;
function priced(rate: number | undefined, before?: number, isFree?: boolean): NonNullable<ModelMetadata['billing']> {
  return { multiplier: rate, isFree, ...(rate !== undefined && before !== undefined && before > rate ? { originalMultiplier: before, discountRatio: rate / before } : {}) };
}

/** Schemas belong to adapters; the common modelRows helper never guesses vendor fields. */
export function copilotMetadata(m: Json): ModelMetadata {
  return { capabilities: { vision: bool(m.capabilities?.supports?.vision), toolCalling: bool(m.capabilities?.supports?.tool_calls) },
    limits: { contextTokens: n(m.capabilities?.limits?.max_context_window_tokens), outputTokens: n(m.capabilities?.limits?.max_output_tokens) },
    // Zero premium-request multiplier does not mean the subscription itself is free.
    billing: priced(n(m.billing?.multiplier)) };
}
export function codexMetadata(m: Json): ModelMetadata {
  return { name: m.display_name, capabilities: { vision: modalities(m.input_modalities), reasoning: m.supports_reasoning_summaries === true ? true : undefined },
    limits: { contextTokens: n(m.context_window), maxContextTokens: n(m.max_context_window) } };
}
export function kiroMetadata(m: Json): ModelMetadata {
  return { capabilities: { vision: modalities(m.supportedInputTypes) }, limits: { contextTokens: n(m.tokenLimits?.maxInputTokens), outputTokens: n(m.tokenLimits?.maxOutputTokens) } };
}
export function opencodeMetadata(m: Json): ModelMetadata {
  const input = n(m.cost?.input), output = n(m.cost?.output);
  const cache = [m.cost?.cache_read, m.cost?.cache_write].filter(v => v != null).map(n);
  return { name: m.name, capabilities: { vision: modalities(m.modalities?.input), reasoning: bool(m.reasoning), toolCalling: bool(m.tool_call) },
    limits: { contextTokens: n(m.limit?.context), outputTokens: n(m.limit?.output) },
    billing: { isFree: input !== undefined && output !== undefined && cache.every(v => v !== undefined) ? input === 0 && output === 0 && cache.every(v => v === 0) : undefined } };
}
export function qoderMetadata(m: Json, now = Date.now()): ModelMetadata {
  const entries = Object.values(m.context_config ?? m.contextConfig ?? {}) as Json[];
  const windows = entries.length ? entries.map(e => n(e?.token_count)).filter((x): x is number => x !== undefined && x > 0)
    : (m.available_context_windows ?? m.availableContextWindows ?? []).map(n).filter((x: number | undefined) => x !== undefined && x > 0);
  const defaultWindow = n(entries.find(e => [true, 1, '1'].includes(e?.is_default))?.token_count) ?? n(m.default_context_window ?? m.defaultContextWindow) ?? n(m.max_input_tokens);
  let rate = n(m.price_factor ?? m.priceFactor), before = n(m.original_price_factor ?? m.originalPriceFactor);
  const promotion = m.promotion ?? m.prommotion;
  const original = n(promotion?.before_promotion_price_factor ?? promotion?.beforePromotionPriceFactor);
  const discount = n(promotion?.discount_factor ?? promotion?.discountFactor);
  if (promotion?.active === true && original !== undefined && original > 0) {
    before = original;
    // Some Qoder lists use zero as a placeholder during a paid promotion.
    if (rate === 0) rate = discount !== undefined ? original * discount : undefined;
  }
  const billing = priced(rate, before, rate !== undefined ? rate === 0 : promotion?.active ? undefined : bool(m.is_free ?? m.isFree));
  // An account's promotion snapshot is only trusted until the next catalog poll.
  if (promotion?.active && billing) { billing.validUntil = new Date(now + 60000).toISOString(); billing.conditions = ['当前账号活动价格']; }
  return { capabilities: { vision: bool(m.is_vl), reasoning: bool(m.is_reasoning) },
    limits: { contextTokens: defaultWindow, maxContextTokens: windows.length ? Math.max(...windows) : undefined, outputTokens: n(m.max_output_tokens) }, billing };
}
export function workbuddyMetadata(m: Json, promotions: unknown = [], now = Date.now()): ModelMetadata {
  const credits = m.credits == null ? undefined : n(String(m.credits).trim().replace(/^x/i, '').replace(/\s+credits?$/i, ''));
  const offers = (Array.isArray(promotions) ? promotions : []).filter(p => p?.kind === 'discount' && p.enabled !== false && p.modelIds?.includes(m.id));
  // Hourly promotion schemas are not stable. Omit billing rather than advertise a stale free rate.
  const billing = offers.some(p => p.schedule?.daily?.length) ? { conditions: ['存在分时活动，当前倍率暂不可确认'] } : priced(credits, undefined, credits === undefined ? undefined : credits === 0);
  if (billing.multiplier !== undefined) for (const p of offers) {
    const from = Date.parse(p.schedule?.validFrom ?? ''), until = Date.parse(p.schedule?.validUntil ?? '');
    if (from > now || until <= now) continue;
    const explicit = p.discount?.discountedCredits;
    const rate = explicit != null ? n(String(explicit).replace(/x$/i, '')) : n(p.discount?.factor) !== undefined ? credits! * Number(p.discount.factor) : undefined;
    if (rate !== undefined && rate < billing.multiplier) Object.assign(billing, priced(rate, credits, rate === 0));
  }
  if (offers.length) {
    const boundaries = offers.flatMap(p => [Date.parse(p.schedule?.validFrom ?? ''), Date.parse(p.schedule?.validUntil ?? '')]).filter(t => Number.isFinite(t) && t > now);
    billing.validUntil = new Date(Math.min(now + 60000, ...boundaries)).toISOString();
  }
  return { capabilities: { vision: bool(m.supportsImages), reasoning: bool(m.supportsReasoning) },
    limits: { contextTokens: n(m.maxInputTokens), outputTokens: n(m.maxOutputTokens) }, billing };
}
export function grokMetadata(m: Json): ModelMetadata { return { limits: { contextTokens: n(m.context_window) } }; }
export function antigravityMetadata(m: Json): ModelMetadata {
  return { name: m.displayName, capabilities: { vision: bool(m.supportsImages) }, limits: { contextTokens: n(m.maxTokens), outputTokens: n(m.maxOutputTokens) } };
}
export function minimaxMetadata(m: Json): ModelMetadata {
  const image = modalities(m.modalities?.input);
  const mode = m.thinking_config?.mode;
  return { name: m.name, capabilities: { vision: m.attachment === true ? true : image ?? bool(m.attachment),
    reasoning: mode === 'forced_off' ? false : mode === 'forced_on' || mode === 'switchable' ? true : bool(m.reasoning) },
    limits: { contextTokens: n(m.limit?.context), outputTokens: n(m.limit?.output) } };
}
export function zcodeMetadata(m: Json): ModelMetadata {
  return { capabilities: { vision: bool(m.properties?.inputFormat?.supportsImage),
    reasoning: Array.isArray(m.optionSpecs?.reasoningLevel?.values) && m.optionSpecs.reasoningLevel.values.length ? true : undefined },
    limits: { contextTokens: n(m.properties?.contextWindow), outputTokens: n(m.optionSpecs?.maxOutputTokens?.max) } };
}
// These catalogs currently have no verified metadata schema beyond ID/name.
export function nameOnlyMetadata(m: Json): ModelMetadata { return { name: m.display_name || m.name || m.modelName || m.displayName || m.id }; }

export function traeMetadata(m: Json, siblings: Json[] = [m], now = Date.now()): ModelMetadata {
  const dev = m.model_detail_list?.find((d: Json) => /__dev$/.test(String(d.model_name)));
  const maxEntry = siblings.find(x => x.model_detail_list?.some((d: Json) => /__max$/.test(String(d.model_name))));
  const context = n(m.context_window_tokens?.dev ?? m.context_window_size?.max?.[0] ?? m.context_window_size?.max ?? m.prompt_max_tokens);
  const max = maxEntry ? siblings.map(x => n(x.context_window_tokens?.max)).find(v => v !== undefined && v > (context ?? 0)) : undefined;
  let billing: ModelMetadata['billing'];
  try {
    const cfg = typeof m.display_contact_config === 'string' ? JSON.parse(m.display_contact_config) : m.display_contact_config;
    if (cfg && typeof cfg === 'object') {
      let rate = cfg.consumption_rate?.enable === false ? undefined : n(cfg.consumption_rate?.data?.rate);
      let before: number | undefined;
      const conditions: string[] = [];
      if (cfg.discount?.enable === true && n(cfg.discount.data?.consumption_rate) !== undefined) {
        before = n(cfg.discount.data?.original_consumption_rate) ?? rate;
        rate = n(cfg.discount.data.consumption_rate); conditions.push('当前账号优惠');
      }
      const activity = cfg.activity_discount;
      const offPeak = activity?.data?.off_peak;
      if (activity?.enable === true && Array.isArray(offPeak?.time_windows) && offPeak.time_windows.length) {
        const zone = offPeak.time_zone || 'Asia/Shanghai';
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const active = (at: number) => {
          const parts = fmt.formatToParts(at); const get = (type: string) => parts.find(p => p.type === type)?.value;
          const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')!) + 1;
          const minute = Number(get('hour')) * 60 + Number(get('minute'));
          return offPeak.time_windows.some((w: Json) => Array.isArray(w.weekdays) && w.weekdays.includes(day) && Number.isInteger(w.start_minute) && Number.isInteger(w.end_minute) && minute >= w.start_minute && minute < w.end_minute);
        };
        const discounted = active(now);
        rate = n(discounted ? offPeak.after_consumption_rate : offPeak.before_consumption_rate);
        before = discounted ? n(offPeak.before_consumption_rate) : undefined;
        conditions.push(`分时价格（${zone}）`);
        billing = priced(rate, before, rate === undefined ? undefined : rate === 0);
        // Refresh no later than the next minute, including sub-hour promotional boundaries.
        billing!.validUntil = new Date(Math.floor(now / 60000) * 60000 + 60000).toISOString();
      }
      billing ??= priced(rate, before ?? n(activity?.data?.current?.before_consumption_rate), rate === undefined ? undefined : rate === 0);
      if (conditions.length) billing.conditions = conditions;
      // Discount data is account-scoped and may change before the catalog itself does.
      billing.validUntil ??= new Date(now + 60000).toISOString();
    }
  } catch { /* Invalid pricing/timezone affects billing only, never model availability. */ }
  return sanitizeModelMetadata({ name: m.display_config?.display_name || m.display_name || m.display_model_name || m.config_name,
    capabilities: { vision: bool(m.multimodal ?? m.display_config?.multimodal), reasoning: Array.isArray(m.reasoning_effort_config?.options) && m.reasoning_effort_config.options.length ? true : undefined },
    limits: { contextTokens: context, maxContextTokens: max, outputTokens: n(dev?.max_tokens) }, billing });
}

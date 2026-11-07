import type { ModelMetadata } from '@juejin-opensource/jusage-core/agent-router/model-metadata';

export function formatModelTokens(value: number): string {
  return value >= 1000000 ? `${Number((value / 1000000).toFixed(2))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(2))}K` : String(value);
}
const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
/** Unknown or expired billing never qualifies for the free-only filter. */
export function isFreeModel(metadata: ModelMetadata | undefined, now = Date.now()): boolean {
  const billing = metadata?.billing;
  return billing?.isFree === true && (!billing.validUntil || Date.parse(billing.validUntil) > now);
}

export function modelPresentation(metadata: ModelMetadata | undefined, now = Date.now()) {
  const tags: string[] = [], details: string[] = [];
  const m = metadata ?? {};
  for (const [key, label] of [['vision', '图片输入（VL）'], ['reasoning', '推理'], ['toolCalling', '工具调用']] as const) {
    if (m.capabilities?.[key] !== undefined) details.push(`${label}：${m.capabilities[key] ? '支持' : '不支持'}`);
  }
  if (m.limits?.contextTokens) {
    details.push(`当前上下文：${m.limits.contextTokens.toLocaleString('zh-CN')} Token`);
  }
  if (m.limits?.maxContextTokens) {
    details.push(`支持的上下文上限：${m.limits.maxContextTokens.toLocaleString('zh-CN')} Token`);
  }
  if (m.limits?.outputTokens) details.push(`最大输出：${formatModelTokens(m.limits.outputTokens)} Token`);
  const expired = !!m.billing?.validUntil && Date.parse(m.billing.validUntil) <= now;
  const billing = expired ? undefined : m.billing;
  if (billing?.isFree === true) tags.push('免费');
  if (billing?.multiplier !== undefined) details.push(`当前账号消费倍率：${number(billing.multiplier)}×（仅适用于此渠道）`);
  if (billing?.originalMultiplier !== undefined) details.push(`原倍率：${number(billing.originalMultiplier)}×`);
  if (billing?.discountRatio !== undefined && billing.discountRatio < 1) details.push(`折扣：${number(billing.discountRatio * 10)}折`);
  details.push(...(billing?.conditions ?? []));
  if (expired) details.push('计费信息已到期，等待刷新');
  return { tags, details };
}

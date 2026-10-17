import type { AntigravitySubscriptionSnapshot } from '../../shared/antigravity-subscription';
import type { QoderSubscriptionSnapshot } from '../../shared/qoder-subscription';
import type { MiniMaxSubscriptionSnapshot } from '../../shared/minimax-subscription';
import { nonNegativeNumber } from '../../shared/subscription-amounts';
import { flattenedSubscriptionDetails, subscriptionDetails, subscriptionAbsoluteTime, subscriptionPoolKey, type SubscriptionDetailRow } from './subscription-details';

export function geminiProgressMetrics(snapshot: AntigravitySubscriptionSnapshot) {
  return snapshot.limits.map((limit) => ({
    poolKey: subscriptionPoolKey('Antigravity 模型额度', limit),
    color: '#2b7eff', label: limit.label,
    remainingPercent: Math.max(0, Math.min(100, 100 - limit.usedPercent)),
    resetsAt: limit.resetsAt,
  }));
}

export function qoderProgressMetrics(snapshot: QoderSubscriptionSnapshot) {
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  return snapshot.limits.map((limit) => {
    const total = nonNegativeNumber(limit.amounts?.total);
    const used = nonNegativeNumber(limit.amounts?.used);
    const remaining = nonNegativeNumber(limit.amounts?.remaining)
      ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
    return {
      poolKey: subscriptionPoolKey('Qoder 账号额度', limit),
      color: '#2b7eff', label: limit.id === 'plan' ? 'Credits' : limit.id === 'add-on' ? 'Add-on' : limit.label,
      valueText: limit.id !== 'add-on' && total !== null && total > 0 && remaining !== null
        ? `剩余 ${numberFormat.format(remaining)} / ${numberFormat.format(total)} ${limit.amounts?.unit ?? 'Credits'}`
        : undefined,
      remainingPercent: total === 0 ? 0
        : total !== null && remaining !== null ? Math.max(0, Math.min(100, remaining / total * 100))
        : Math.max(0, Math.min(100, 100 - limit.usedPercent)),
      resetDisplay: 'days-only' as const,
      resetsAt: limit.resetsAt,
    };
  });
}

export function qoderExpiryDetails(snapshot: QoderSubscriptionSnapshot): SubscriptionDetailRow[] {
  const valid = snapshot.limits.filter((limit) => subscriptionAbsoluteTime(limit.resetsAt) !== null);
  const primary = valid.find((limit) => limit.id === 'plan');
  const expiry = primary?.resetsAt ?? (valid.length ? Math.min(...valid.map((limit) => limit.resetsAt!)) : null);
  const value = subscriptionAbsoluteTime(expiry);
  return value ? [{ label: primary ? '套餐到期时间' : '最近到期时间', value }] : [];
}

export function miniMaxProgressMetrics(snapshot: MiniMaxSubscriptionSnapshot) {
  const limits = snapshot.modelLimits?.length ? snapshot.modelLimits : snapshot.limits;
  const rank = (model?: string) => !model || model === 'general' ? 0 : model === 'image' ? 1 : model === 'video' ? 2 : 3;
  return limits.filter((limit) => !(limit.modelName === 'video' && limit.id === 'five-hour'))
    .sort((a, b) => rank(a.modelName) - rank(b.modelName)).map((limit) => {
    const group: 'image' | 'video' | undefined = limit.modelName === 'image' || limit.modelName === 'video' ? limit.modelName : undefined;
    const amounts = limit.amounts;
    const total = amounts?.total;
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const remaining = valid(amounts?.remaining) ? amounts.remaining
      : valid(total) && valid(amounts?.used) && amounts.used <= total ? total - amounts.used : null;
    return {
      poolKey: subscriptionPoolKey('MiniMax Coding Plan', limit),
      color: '#2b7eff',
      group,
      collapsedHidden: Boolean(limit.modelName && limit.modelName !== 'general'),
      label: group || !limit.modelName || limit.modelName === 'general' ? limit.label : `${limit.modelName} · ${limit.label}`,
      remainingPercent: limit.unlimited ? 100
        : group && remaining !== null && valid(total) && total > 0 ? Math.max(0, Math.min(100, remaining / total * 100))
        : Math.max(0, Math.min(100, 100 - limit.usedPercent)),
      resetsAt: limit.resetsAt,
    };
  });
}

/** Filter invalid readings before applying the collapsed preview policy. */
export function selectProgressMetrics<T extends { remainingPercent: number | null; collapsedHidden?: boolean }>(
  metrics: readonly T[],
  collapsed: boolean,
  limit: number | null = 3,
  expandable = false,
): T[] {
  const valid = metrics.filter((metric) => metric.remainingPercent !== null && Number.isFinite(metric.remainingPercent));
  if (expandable && !collapsed) return valid;
  const preview = expandable ? valid.filter((metric) => !metric.collapsedHidden) : valid;
  return limit === null ? preview : preview.slice(0, limit);
}

export function miniMaxResetDetails(snapshot: MiniMaxSubscriptionSnapshot): SubscriptionDetailRow[] {
  const limits = snapshot.modelLimits?.length ? snapshot.modelLimits : snapshot.limits;
  const textLimits = limits.filter((limit) => limit.modelName !== 'image' && limit.modelName !== 'video');
  const rows = flattenedSubscriptionDetails(
    subscriptionDetails({ ...snapshot, modelLimits: textLimits, limits: textLimits }, 'MiniMax Coding Plan'),
    miniMaxProgressMetrics(snapshot),
  ).filter((row) => row.label.endsWith('重置时间')).map((row) => ({
    ...row,
    label: row.label.replace(/^general · 5h /, '会话').replace(/^general · 7d /, '每周'),
  }));
  for (const model of ['image', 'video'] as const) {
    const times = limits.filter((limit) => limit.modelName === model)
      .flatMap((limit) => {
        const time = subscriptionAbsoluteTime(limit.resetsAt);
        return time ? [{ label: limit.label, time }] : [];
      });
    if (!times.length) continue;
    const unique = [...new Set(times.map((item) => item.time))];
    rows.push({
      label: model === 'image' ? '图片重置' : '视频重置',
      value: unique.length === 1 ? unique[0] : times.map((item) => `${item.label}：${item.time}`).join('；'),
    });
  }
  return rows;
}

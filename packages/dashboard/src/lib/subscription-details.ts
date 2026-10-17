import type { SubscriptionAmounts } from '@juejin-opensource/jusage-core/subscription/shared/subscription-amounts';

export interface SubscriptionDetailRow {
  label: string;
  value: string;
  tag?: '已用' | '剩余';
  tone?: 'success' | 'warning' | 'danger' | 'muted';
}
export interface SubscriptionDetailSection {
  kind: 'quota' | 'metadata';
  title: string;
  poolKey?: string;
  cycle?: string;
  rows: SubscriptionDetailRow[];
}
interface DetailWindow {
  id?: string;
  label?: string;
  usedPercent?: number;
  remainingPercent?: number | null;
  resetsAt?: number | null;
  startsAt?: number;
  expiresAt?: number;
  resetKind?: SubscriptionTimeKind;
  unlimited?: boolean;
  exhausted?: boolean;
  modelName?: string;
  amounts?: SubscriptionAmounts;
  remaining?: number | null;
  granted?: number;
  toppedUp?: number;
  available?: boolean;
}
/** Structural whitelist: authentication and arbitrary vendor payloads never enter presentation. */
interface DetailSnapshot {
  planLabel: string | null;
  fetchedAt: number | null;
  stale: boolean;
  message: string | null;
  limits?: readonly DetailWindow[];
  modelLimits?: readonly DetailWindow[];
  fiveHour?: DetailWindow | null;
  weekly?: DetailWindow | null;
  sevenDay?: DetailWindow | null;
  cursorModels?: DetailWindow | null;
  otherModels?: DetailWindow | null;
  grokBot?: DetailWindow | null;
  plan?: DetailWindow | null;
  credits?: { balance?: number; unlimited?: boolean; hasCredits?: boolean };
  region?: string | null;
  provider?: string | null;
}
export type SubscriptionTimeKind = '重置时间' | '到期时间' | '账期结束';

export function subscriptionPercentageTone(remaining: number): SubscriptionDetailRow['tone'] {
  return remaining <= 0 ? 'muted' : remaining <= 20 ? 'danger' : remaining <= 50 ? 'warning' : 'success';
}
function numeric(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}
function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function subscriptionAbsoluteTime(value?: number | null): string | null {
  if (!validNumber(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function subscriptionDetails(
  snapshot: DetailSnapshot,
  source: string,
  timeKind: SubscriptionTimeKind = '重置时间',
): SubscriptionDetailSection[] {
  const sections: SubscriptionDetailSection[] = [];
  const windows: DetailWindow[] = snapshot.modelLimits?.length ? [...snapshot.modelLimits] : snapshot.limits ? [...snapshot.limits] : [
    snapshot.fiveHour && { ...snapshot.fiveHour, label: '5h' },
    (snapshot.weekly ?? snapshot.sevenDay) && { ...(snapshot.weekly ?? snapshot.sevenDay), label: '7d' },
    snapshot.cursorModels && { ...snapshot.cursorModels, label: 'Auto' },
    snapshot.otherModels && { ...snapshot.otherModels, label: 'API' },
    snapshot.plan && { ...snapshot.plan, label: 'Plan' },
    snapshot.grokBot && { ...snapshot.grokBot, label: 'Grok Bot', resetKind: '重置时间' as const },
  ].filter((value): value is DetailWindow & { label: string } => Boolean(value));
  for (const window of windows) {
    const rows: SubscriptionDetailRow[] = [];
    const balance = window.remaining;
    if (validNumber(balance)) {
      rows.push({ label: '总余额', value: `¥${balance.toFixed(2)}` });
      if (validNumber(window.granted)) rows.push({ label: '赠送余额', value: `¥${window.granted.toFixed(2)}` });
      if (validNumber(window.toppedUp)) rows.push({ label: '充值余额', value: `¥${window.toppedUp.toFixed(2)}` });
      if (window.available === false) rows.push({ label: '余额可供 API 调用', value: '不可用', tone: 'warning' });
    } else if (window.exhausted) {
      rows.push({ label: '额度状态', value: '已用尽', tone: 'muted' });
    } else if (window.unlimited) {
      rows.push({ label: '额度状态', value: '无限' });
    } else {
      const remaining = validNumber(window.remainingPercent) ? window.remainingPercent
        : validNumber(window.usedPercent) ? 100 - window.usedPercent : null;
      const amounts = window.amounts;
      // Unit-bearing counters use absolute amounts; subscription pools keep percentages.
      const showAmounts = amounts && (Boolean(amounts.unit) || remaining === null);
      if (showAmounts) {
        const total = validNumber(amounts.total) && amounts.total >= 0 ? amounts.total : null;
        const left = validNumber(amounts.remaining) && amounts.remaining >= 0 ? amounts.remaining : null;
        const used = validNumber(amounts.used) && amounts.used >= 0 ? amounts.used
          : total !== null && left !== null && left <= total ? total - left : null;
        const unit = amounts.unit ? ` ${amounts.unit}` : '';
        if (used !== null) {
          rows.push({ label: '用量', tag: '已用', value: `${numeric(used)}${total !== null ? `/${numeric(total)}` : ''}${unit}` });
        } else if (left !== null) {
          rows.push({ label: '用量', tag: '剩余', value: `${numeric(left)}${total !== null ? `/${numeric(total)}` : ''}${unit}` });
        }
      } else if (remaining !== null) {
        const bounded = Math.max(0, Math.min(100, remaining));
        rows.push({ label: '剩余额度', value: `${numeric(bounded)}%`, tone: subscriptionPercentageTone(bounded) });
      }
    }
    const reset = subscriptionAbsoluteTime(window.resetsAt);
    if (reset) rows.push({ label: window.resetKind ?? timeKind, value: reset });
    const expires = subscriptionAbsoluteTime(window.expiresAt);
    if (expires && !(expires === reset && (window.resetKind ?? timeKind) === '到期时间')) rows.push({ label: '到期时间', value: expires });
    if (rows.length) sections.push({ kind: 'quota', title: [window.modelName, window.label ?? '额度'].filter(Boolean).join(' · '), poolKey: subscriptionPoolKey(source, window), cycle: window.label, rows });
  }
  const credits = snapshot.credits;
  if (credits) {
    const rows: SubscriptionDetailRow[] = [];
    if (credits.unlimited) rows.push({ label: '额度状态', value: '无限' });
    if (validNumber(credits.balance)) rows.push({ label: '余额', value: numeric(credits.balance) });
    if (credits.hasCredits === false && !credits.unlimited && !validNumber(credits.balance)) rows.push({ label: 'Credits 状态', value: '无可用额度' });
    if (rows.length) sections.push({ kind: 'quota', title: 'Credits', rows });
  }
  return sections;
}

/** Presentation identity is independent of translated titles and summary aliases. */
export function subscriptionPoolKey(source: string, window: Pick<DetailWindow, 'id' | 'label' | 'modelName'>): string {
  return JSON.stringify([source, window.modelName ?? '', window.id ?? window.label ?? '额度']);
}

export interface SubscriptionSummaryReference {
  poolKey?: string;
  label: string;
  valueText?: string;
  hideProgress?: boolean;
  remainingPercent?: number | null;
}

/** Keep full dates and supplemental counters, removing values already in the summary. */
export function flattenedSubscriptionDetails(
  sections: readonly SubscriptionDetailSection[],
  summaries: readonly SubscriptionSummaryReference[],
): SubscriptionDetailRow[] {
  const seenByPool = new Map<string, Set<string>>();
  return sections.flatMap((section, index) => {
    const summary = section.poolKey ? summaries.find((item) => item.poolKey === section.poolKey) : undefined;
    const prefix = section.title === '5h' ? '会话' : section.title === '7d' ? '每周' : section.title;
    const identityKey = section.poolKey ?? `section-${index}`;
    const seen = seenByPool.get(identityKey) ?? new Set<string>();
    seenByPool.set(identityKey, seen);
    return section.rows
      .filter((row) => {
        const identity = JSON.stringify([row.label, row.tag, row.value]);
        if (seen.has(identity)) return false;
        seen.add(identity);
        if (!summary) return true;
        if (['5h', '7d'].includes(section.cycle ?? '') && (row.tag || row.label === '剩余额度')) return false;
        if (row.label === '剩余额度' && row.value.endsWith('%') && !summary.hideProgress && !summary.valueText) return false;
        if (row.label === '额度状态' && (row.value === summary.valueText || (row.value === '已用尽' && summary.remainingPercent === 0))) return false;
        if (row.label === '总余额' && summary.hideProgress && summary.valueText === row.value) return false;
        return true;
      })
      .map((row) => ({
        ...row,
        label: row.tag ? section.title : sections.length === 1 && !['5h', '7d', 'MCP'].includes(section.title)
          ? row.label : `${prefix}${/^[\u4e00-\u9fff]+$/.test(prefix) ? '' : ' '}${row.label}`,
      }));
  });
}

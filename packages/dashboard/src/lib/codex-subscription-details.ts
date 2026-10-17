import type { CodexSubscriptionSnapshot } from '@juejin-opensource/jusage-core/subscription/shared/codex-subscription';
import { subscriptionAbsoluteTime, type SubscriptionDetailRow } from './subscription-details.ts';

/** Extra Codex details only; percentages and plan already appear in the summary. */
export function codexSubscriptionDetails(snapshot: CodexSubscriptionSnapshot): SubscriptionDetailRow[] {
  const balance = snapshot.credits?.balance;
  const rows: SubscriptionDetailRow[] = [];
  const sessionReset = subscriptionAbsoluteTime(snapshot.fiveHour?.resetsAt);
  const weeklyReset = subscriptionAbsoluteTime(snapshot.weekly?.resetsAt);
  if (snapshot.resetCredits) rows.push({ label: '重置卡', value: `${snapshot.resetCredits.availableCount} 张` });
  if (typeof balance === 'number' && Number.isFinite(balance)) rows.push({ label: '积分余额', value: `${balance.toFixed(2)} 积分` });
  if (sessionReset) rows.push({ label: '会话重置时间', value: sessionReset });
  if (weeklyReset) rows.push({ label: '每周重置时间', value: weeklyReset });
  return rows;
}

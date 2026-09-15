export const TRAY_USAGE_GET_CHANNEL = 'tray-usage:get';
export const TRAY_USAGE_SET_CHANNEL = 'tray-usage:set';
export const TRAY_USAGE_CHANGED_CHANNEL = 'tray-usage:changed';
export const TRAY_USAGE_MODE_GET_CHANNEL = 'tray-usage-mode:get';
export const TRAY_USAGE_MODE_SET_CHANNEL = 'tray-usage-mode:set';
export const TRAY_USAGE_MODE_CHANGED_CHANNEL = 'tray-usage-mode:changed';

/** macOS 菜单栏今日用量的展示内容。 */
export type TrayUsageMode = 'both' | 'tokens' | 'cost';
export const DEFAULT_TRAY_USAGE_MODE: TrayUsageMode = 'both';

export function isTrayUsageMode(value: unknown): value is TrayUsageMode {
  return value === 'both' || value === 'tokens' || value === 'cost';
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000_000) {
    const v = (tokens / 1_000_000_000).toFixed(1).replace(/\.0$/, '');
    return `${v}B`;
  }
  if (tokens >= 1_000_000) {
    const v = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${v}M`;
  }
  if (tokens >= 1_000) {
    const v = (tokens / 1_000).toFixed(1).replace(/\.0$/, '');
    return `${v}K`;
  }
  return Math.round(tokens).toString();
}

export function formatTrayUsage(summary: {
  todayCostUsd?: number | null;
  todayTokens?: number | null;
}, mode: TrayUsageMode = DEFAULT_TRAY_USAGE_MODE): string {
  const cost = Number(summary.todayCostUsd);
  const tokens = Number(summary.todayTokens);
  // 菜单栏同时展示今日 Token 和费用，零费用模型也保留金额信息。
  const tokenText = `${formatCompactTokens(tokens)} Token`;
  const costText = Number.isFinite(cost) && cost > 0
    ? cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
    : '$0.00';
  if (mode === 'tokens') return tokenText;
  if (mode === 'cost') return costText;
  return `${tokenText} · ${costText}`;
}

import type { DashboardUsageSummary } from '@/lib/dashboard-mock-data';
import { formatTokens, formatTokensExact } from '@/lib/format';
import { cn } from '@/lib/utils';

export function TokenBreakdownPanel({
  showRequestHelp,
  exact = false,
  summary,
}: {
  showRequestHelp: boolean;
  exact?: boolean;
  summary: DashboardUsageSummary;
}) {
  const input = summary.inputTokens;
  const output = summary.outputTokens;
  const cacheRead = summary.cachedInputTokens;
  const cacheWrite = summary.cacheCreationInputTokens;
  const other = Math.max(
    0,
    summary.totalTokens - input - output - cacheRead - cacheWrite,
  );
  const requestIncomplete =
    showRequestHelp &&
    summary.requestCount == null &&
    (summary.knownRequestCount ?? 0) > 0;

  return (
    <div className="grid min-w-44 gap-1.5 text-xs">
      <p className="font-medium text-foreground">Token 构成</p>
      <BreakdownRow exact={exact} label="输入" value={input} />
      <BreakdownRow exact={exact} label="输出" value={output} />
      <div className="grid gap-1">
        <p className="text-muted">缓存</p>
        <BreakdownRow exact={exact} indented label="读" value={cacheRead} />
        <BreakdownRow exact={exact} indented label="写" value={cacheWrite} />
      </div>
      <BreakdownRow exact={exact} label="其它" value={other} />
      <div className="my-0.5 h-px bg-border/70" />
      <BreakdownRow exact={exact} emphasize label="合计" value={summary.totalTokens} />
      <p className="pt-0.5 text-[10px] leading-4 text-muted">
        总 Token = 输入 + 输出 + 缓存读 + 缓存写 + 其它
      </p>
      {showRequestHelp ? (
        <p className="pt-1 text-[10px] leading-4 text-muted">
          请求数优先用本地请求证据；无证据时按 conversation 累计
          {requestIncomplete ? '，不完整时可能偏低' : ''}
          。
        </p>
      ) : null}
    </div>
  );
}

function BreakdownRow({
  exact,
  emphasize = false,
  indented = false,
  label,
  value,
}: {
  exact: boolean;
  emphasize?: boolean;
  indented?: boolean;
  label: string;
  value: number;
}) {
  return (
    <div
      className={cn(
        'flex w-full items-center justify-between gap-4',
        indented && 'pl-3',
      )}
    >
      <span className={emphasize ? 'font-medium text-foreground' : 'text-muted'}>
        {label}
      </span>
      <span
        className={cn(
          'font-mono tabular-nums',
          emphasize ? 'font-medium text-foreground' : 'text-foreground',
        )}
      >
        {exact ? formatTokensExact(value) : formatTokens(value)}
      </span>
    </div>
  );
}

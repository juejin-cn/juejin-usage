import { CircleQuestion } from '@gravity-ui/icons';
import { Button, Card, Tooltip } from '@heroui/react';
import type { LocalUsageMetrics } from '@juejin-opensource/jusage-core/local-metrics';
import { formatTokens, formatTokensExact } from '@/lib/format';

export function LocalUsageMetricCards({
  metrics,
}: {
  metrics?: LocalUsageMetrics;
}) {
  const rows = [
    {
      label: '请求数',
      value: metrics?.requestCount ?? null,
      format: (value: number) => value.toLocaleString('zh-CN'),
      help: '日志中可识别且包含用量的模型调用次数。同一调用的流式更新只计一次，不包含未记录用量的失败或取消请求。',
      missing: metrics?.knownRequestCount
        ? `已记录 ${metrics.knownRequestCount.toLocaleString('zh-CN')} 次，数据不完整`
        : '请求数据不完整',
    },
    {
      label: '缓存读取',
      value: metrics?.cacheReadTokens ?? null,
      format: formatTokens,
      help: '从缓存复用的输入 Token，已包含在输入 Token 和总 Token 中。',
      missing: '当前来源缺少缓存读取数据',
    },
    {
      label: '缓存创建',
      value: metrics?.cacheWriteTokens ?? null,
      format: formatTokens,
      help: '写入缓存的输入 Token，已包含在输入 Token 和总 Token 中。',
      missing: '当前来源缺少缓存创建数据',
    },
    {
      label: '缓存命中率',
      value: metrics?.cacheHitRate ?? null,
      format: (value: number) => `${(value * 100).toFixed(1)}%`,
      help: '缓存读取 ÷（普通输入 + 缓存读取 + 缓存创建）。按 Token 加权计算，输出 Token 不参与计算。',
      missing:
        metrics?.cacheReadTokens === 0 &&
        metrics?.cacheWriteTokens === 0 &&
        metrics?.uncachedInputTokens === 0
          ? '暂无输入 Token'
          : '缓存数据不完整',
    },
  ];
  return (
    <section
      aria-label="请求与缓存统计"
      className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4"
    >
      {rows.map((row) => (
        <Card
          key={row.label}
          className="min-h-[5.5rem] min-w-0 rounded-2xl p-3"
        >
          <Card.Content className="flex h-full flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">
                {row.label}
              </span>
              <Tooltip delay={100}>
                <Button
                  aria-label={`${row.label}统计说明`}
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="h-5 min-h-5 w-5 min-w-5 text-muted"
                >
                  <CircleQuestion className="size-3.5" />
                </Button>
                <Tooltip.Content className="max-w-72 p-3" placement="top">
                  {row.help}
                </Tooltip.Content>
              </Tooltip>
            </div>
            <span
              className="text-xl font-semibold tabular-nums"
              title={
                row.value === null
                  ? undefined
                  : row.label === '缓存命中率'
                    ? row.format(row.value)
                    : formatTokensExact(row.value)
              }
            >
              {row.value === null ? '—' : row.format(row.value)}
            </span>
            {row.value === null && (
              <span className="text-xs text-muted">
                {metrics ? row.missing : '当前本地服务暂不提供此统计'}
              </span>
            )}
          </Card.Content>
        </Card>
      ))}
    </section>
  );
}

import type { LeaderboardMetric, ModelLeaderboardRow, ModelLeaderboardTrendPoint } from '@/lib/api';

export function ModelTrend({ row, metric }: { row: ModelLeaderboardRow; metric: LeaderboardMetric }) {
  const values = (points: ModelLeaderboardTrendPoint[]) =>
    points.map((point) => metric === 'tokens' ? point.tokens : point.costUsd);
  const current = values(row.trend);
  const previous = row.previousTrend ? values(row.previousTrend) : null;
  const maximum = Math.max(1, ...current, ...(previous ?? []));
  const points = (series: number[]): Array<[number, number]> => series.map((value, index) => {
    const x = series.length < 2 ? 52 : 2 + index * 100 / (series.length - 1);
    return [x, 27 - value / maximum * 22];
  });
  const smoothPath = (series: Array<[number, number]>) => {
    if (series.length === 0) return '';
    const coordinate = ([x, y]: [number, number]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
    let path = `M ${coordinate(series[0]!)}`;
    for (let index = 0; index < series.length - 1; index++) {
      const before = series[index - 1] ?? series[index]!;
      const start = series[index]!;
      const end = series[index + 1]!;
      const after = series[index + 2] ?? end;
      const dx = (end[0] - start[0]) / 3;
      const low = Math.min(start[1], end[1]);
      const high = Math.max(start[1], end[1]);
      const firstY = Math.max(low, Math.min(high, start[1] + (end[1] - before[1]) / 6));
      const secondY = Math.max(low, Math.min(high, end[1] - (after[1] - start[1]) / 6));
      path += ` C ${coordinate([start[0] + dx, firstY])} ${coordinate([end[0] - dx, secondY])} ${coordinate(end)}`;
    }
    return path;
  };
  const currentLine = smoothPath(points(current));

  return (
    <svg
      aria-label={`${row.model}${metric === 'tokens' ? ' Token' : '金额'}趋势${previous ? '，虚线为上期' : ''}`}
      className="h-8 w-26 shrink-0 overflow-hidden rounded-full bg-accent/5 text-accent"
      role="img"
      viewBox="0 0 104 32"
    >
      {current.length > 1 && <path d={`${currentLine} L 102 30 Q 52 31 2 30 Z`} fill="currentColor" opacity="0.07" />}
      {previous && <path d={smoothPath(points(previous))} fill="none" stroke="#94a3b8" strokeDasharray="4 4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />}
      <path d={currentLine} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

export function ModelChange({ row }: { row: ModelLeaderboardRow }) {
  if (row.previousValue === null || row.previousValue === 0 || row.changePct === null || row.changePct === 0) {
    return <span className="text-muted">-</span>;
  }
  return (
    <span className={row.changePct > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}>
      {row.changePct > 0 ? '↑' : '↓'} {Math.abs(row.changePct).toFixed(1)}%
    </span>
  );
}

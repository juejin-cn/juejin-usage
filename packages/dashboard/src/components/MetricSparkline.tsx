import { useId, useMemo } from 'react';
import { Curve } from 'recharts';

export function MetricSparkline({
  label,
  values,
  stroke,
  edgeToEdge = false,
  smooth = false,
  className = 'h-6 w-16 justify-self-end',
}: {
  label: string;
  values: readonly number[];
  stroke: string;
  edgeToEdge?: boolean;
  smooth?: boolean;
  className?: string;
}) {
  const gradientId = useId().replace(/:/g, '');
  const points = useMemo(
    () => values.filter((value) => Number.isFinite(value)),
    [values],
  );

  if (points.length < 2) {
    return (
      <div
        aria-hidden="true"
        className={className}
      />
    );
  }

  const width = 64;
  const height = 24;
  const padding = 2;
  const insetX = edgeToEdge ? 0 : padding;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const coordinates = points.map((value, index) => ({
    x: insetX + (index / (points.length - 1)) * (width - insetX * 2),
    y: height - padding - ((value - min) / span) * (height - padding * 2),
  }));
  const curveType = smooth ? 'monotoneX' : 'linear';

  return (
    <div aria-label={label} className={className} role="img">
      <svg
        aria-hidden="true"
        className="h-full w-full overflow-visible"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={edgeToEdge ? 0.36 : 0.24} />
            {edgeToEdge && <stop offset="65%" stopColor={stroke} stopOpacity={0.13} />}
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Curve
          points={coordinates}
          type={curveType}
          baseLine={height}
          layout="horizontal"
          fill={`url(#${gradientId})`}
        />
        <Curve
          points={coordinates}
          type={curveType}
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

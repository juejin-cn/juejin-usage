/** Keep the first `columns * rows` items visible; the rest collapse behind “更多”. */
export function splitVisibleRows<T>(items: readonly T[], columns: number, rows: number): { visible: T[]; rest: T[] } {
  const capacity = Math.max(1, columns) * Math.max(1, rows);
  if (items.length <= capacity) return { visible: [...items], rest: [] };
  return { visible: items.slice(0, capacity), rest: items.slice(capacity) };
}

/** Matches `grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5`. */
export function gatewayProviderColumns(viewportWidth: number): number {
  if (viewportWidth >= 1536) return 5;
  if (viewportWidth >= 1280) return 4;
  if (viewportWidth >= 640) return 3;
  if (viewportWidth >= 480) return 2;
  return 1;
}

/** Matches `grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))]` with `gap-2`. */
export function gatewayRuntimeColumns(containerWidth: number, minTile = 240, gap = 8): number {
  if (containerWidth <= 0) return 1;
  return Math.max(1, Math.floor((containerWidth + gap) / (minTile + gap)));
}

/**
 * Run `fn` after the next two animation frames so the current UI commit
 * (e.g. Tabs selected styles) can paint before heavier work starts.
 */
export function scheduleAfterPaint(fn: () => void): () => void {
  let cancelled = false;
  let raf2 = 0;
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(() => {
      if (!cancelled) fn();
    });
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf1);
    cancelAnimationFrame(raf2);
  };
}

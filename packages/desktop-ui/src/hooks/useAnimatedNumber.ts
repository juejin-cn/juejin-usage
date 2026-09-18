import { useEffect, useRef, useState } from 'react';

/**
 * Tween a number toward `target` with an ease-out curve.
 *
 * Animates from the previous value rather than always from 0, so periodic data
 * refreshes roll the delta instead of replaying the whole count-up.
 */
export function useAnimatedNumber(target: number, duration = 1_200): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;

    // Unchanged target: do not start an rAF loop (refresh with same metrics).
    if (Object.is(from, target) || Math.abs(from - target) < 1e-9) {
      fromRef.current = target;
      setValue(target);
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target;
      setValue(target);
      return;
    }

    let frameId = 0;
    const startedAt = performance.now();

    const update = (now: number) => {
      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + (target - from) * eased;

      fromRef.current = next;
      setValue(next);

      if (progress < 1) {
        frameId = requestAnimationFrame(update);
      } else {
        fromRef.current = target;
      }
    };

    frameId = requestAnimationFrame(update);

    return () => cancelAnimationFrame(frameId);
  }, [duration, target]);

  return value;
}

import { useAnimatedNumber } from '../hooks/useAnimatedNumber';

/** Shared dashboard/pet numeric value; typography inherits the caller's size and weight. */
export function AnimatedNumber({ value, format, animateFromZero = false }: {
  value: number;
  format: (value: number) => string;
  animateFromZero?: boolean;
}) {
  const animatedValue = useAnimatedNumber(value, 1200, animateFromZero ? 0 : value);
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{format(animatedValue)}</span>;
}

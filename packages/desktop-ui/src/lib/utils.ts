import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

const TOKEN_COUNT_UNITS = [
  { value: 1_000_000_000_000, suffix: 'T' },
  { value: 1_000_000_000, suffix: 'B' },
  { value: 1_000_000, suffix: 'M' },
  { value: 1_000, suffix: 'K' },
] as const;

/**
 * Combine class names with Tailwind-aware conflict resolution.
 * Shared class-name helper for business components and chart primitives.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a potentially large Token count using compact international units.
 *
 * Examples:
 * - 1_000 → 1K
 * - 1_000_000 → 1M
 * - 100_000_000 → 100M
 * - 1_000_000_000 → 1B
 */
export function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '0';

  const absoluteValue = Math.abs(value);
  const unitIndex = TOKEN_COUNT_UNITS.findIndex(
    (unit) => absoluteValue >= unit.value,
  );

  if (unitIndex === -1) {
    return Math.round(value).toLocaleString('en-US');
  }

  let selectedIndex = unitIndex;
  let unit = TOKEN_COUNT_UNITS[selectedIndex];
  let scaledValue = roundCompactValue(value / unit.value);

  if (
    Math.abs(scaledValue) >= 1_000 &&
    selectedIndex > 0
  ) {
    selectedIndex -= 1;
    unit = TOKEN_COUNT_UNITS[selectedIndex];
    scaledValue = roundCompactValue(value / unit.value);
  }

  return `${scaledValue.toLocaleString('en-US', {
    maximumFractionDigits: 1,
  })}${unit.suffix}`;
}

function roundCompactValue(value: number) {
  return Math.round(value * 10) / 10;
}

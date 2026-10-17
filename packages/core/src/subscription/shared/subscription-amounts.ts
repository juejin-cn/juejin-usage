/** Absolute values from a vendor response, never reconstructed from a percentage. */
export interface SubscriptionAmounts {
  total?: number;
  used?: number;
  remaining?: number;
  /** Omit when the vendor has not established the unit. */
  unit?: string;
}

export function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function subscriptionAmounts(totalValue: unknown, usedValue: unknown, remainingValue?: unknown, unit?: string): SubscriptionAmounts | undefined {
  const total = nonNegativeNumber(totalValue);
  const used = nonNegativeNumber(usedValue);
  const remaining = nonNegativeNumber(remainingValue);
  if (total === null && used === null && remaining === null) return undefined;
  return {
    ...(total === null ? {} : { total }),
    ...(used === null ? {} : { used }),
    ...(remaining === null ? {} : { remaining }),
    ...(unit ? { unit } : {}),
  };
}

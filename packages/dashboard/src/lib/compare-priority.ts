/** Lower index wins; ids absent from the list keep relative order after listed ones. */
export function compareByPriority(a: string, b: string, order: readonly string[]): number {
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index < 0 ? order.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

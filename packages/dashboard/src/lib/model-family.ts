/**
 * Collapse vendor/`auto-` spellings of one model (aligned with ai-usage
 * `apps/server/src/routers/model-family.ts`).
 */

/** `group/auto-deepseek-v4-1-flash` → `deepseek-v4-1-flash`. */
export function modelDisplayName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed.includes('/')) return trimmed;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const deprefixed = base.replace(/^auto-(?=.)/, '');
  return deprefixed || trimmed;
}

/** The map key every spelling of a model collapses into. */
export function modelFamilyKey(model: string): string {
  return modelDisplayName(model)
    .toLocaleLowerCase()
    .replace(/(?<!\d)(\d{1,3})-(\d{1,3})(?=-|$)/g, '$1.$2');
}

/**
 * Pick the spelling shown in the UI: the prefix-free name that carries the
 * most usage. Ties resolve lexicographically.
 */
export function pickModelDisplayName(
  variants: ReadonlyMap<string, number>,
): string {
  const totals = new Map<string, number>();
  for (const [raw, tokens] of variants) {
    const name = modelDisplayName(raw);
    totals.set(name, (totals.get(name) ?? 0) + tokens);
  }

  let best = '';
  let bestTokens = -1;
  for (const [name, tokens] of totals) {
    if (
      tokens > bestTokens ||
      (tokens === bestTokens && name.localeCompare(best) < 0)
    ) {
      best = name;
      bestTokens = tokens;
    }
  }
  return best;
}

/** Build a set of family keys for selected model filter values. */
export function modelFamilySet(models: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const model of models) {
    if (!model) continue;
    set.add(modelFamilyKey(model));
  }
  return set;
}

export function modelInFamilySet(
  model: string,
  families: ReadonlySet<string>,
): boolean {
  return families.has(modelFamilyKey(model));
}

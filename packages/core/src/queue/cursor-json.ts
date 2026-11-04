/**
 * Compare JSON cursor state without allocating another full serialized file.
 * The first three levels are the source, its collections and their entries;
 * stringify small batches of files/watermarks/hashes instead of a multi-MB collection.
 * Keep native JSON semantics for leaf entries (undefined, escapes, toJSON).
 * This deliberately does not proxy parser objects or trust filesProcessed:
 * parsers can mutate nested offsets/dedup state without producing usage rows.
 */
export function matchesCursorJson(value: unknown, serialized: string): boolean {
  let offset = 0;
  function consume(chunk: string): boolean {
    if (!serialized.startsWith(chunk, offset)) return false;
    offset += chunk.length;
    return true;
  }
  function visit(current: unknown, depth: number): boolean {
    if (current === null || typeof current !== 'object' || depth >= 3
      || typeof (current as { toJSON?: unknown }).toJSON === 'function') {
      return consume(JSON.stringify(current) ?? 'null');
    }
    if (depth === 2 && Array.isArray(current)) {
      const batchSize = 128;
      if (!consume('[')) return false;
      let first = true;
      for (let index = 0; index < current.length; index += batchSize) {
        const batch = current.slice(index, index + batchSize);
        const chunk = JSON.stringify(batch).slice(1, -1);
        if (!chunk) continue;
        if (!first && !consume(',')) return false;
        first = false;
        if (!consume(chunk)) return false;
      }
      return consume(']');
    }
    if (Array.isArray(current)) {
      if (!consume('[')) return false;
      for (let index = 0; index < current.length; index++) {
        if (index > 0 && !consume(',')) return false;
        if (!visit(current[index], depth + 1)) return false;
      }
      return consume(']');
    }
    if (!consume('{')) return false;
    let first = true;
    for (const key of Object.keys(current)) {
      const entry = (current as Record<string, unknown>)[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
      if (!first && !consume(',')) return false;
      first = false;
      if (!consume(JSON.stringify(key)) || !consume(':') || !visit(entry, depth + 1)) return false;
    }
    return consume('}');
  }
  return visit(value, 0) && offset === serialized.length;
}

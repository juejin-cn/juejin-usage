/**
 * Browser-safe project display helpers.
 * Keep this file free of node: imports — dashboard/desktop import it via
 * `@juejin-opensource/jusage-core/project-label`.
 *
 * Contract: a project label is the last folder of a filesystem path.
 * Encodings are unwrapped first; short names (`peeple-app`) stay as-is.
 *
 * Wrappers this helper understands:
 *   percent-encoding  `%2FUsers%2Fme%2Fapp`
 *   file URL          `file:///Users/me/app`
 *   raw path          `/Users/me/app` or `C:\Users\me\app`
 */

/** RFC 3986 percent-encoded octet. Not a product-specific `/` check. */
const PERCENT_ENCODED_OCTET = /%[0-9A-Fa-f]{2}/;

function posixBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = normalized.lastIndexOf('/');
  const name = (i >= 0 ? normalized.slice(i + 1) : normalized).trim();
  return name || 'unknown';
}

/**
 * Unwrap `%XX` sequences, including accidental double-encoding.
 * Invalid sequences (e.g. trailing `%`) stay as-is — decodeURIComponent throws.
 */
function unwrapPercentEncoding(raw: string): string {
  let current = raw;
  for (let i = 0; i < 4; i++) {
    if (!PERCENT_ENCODED_OCTET.test(current)) return current;
    try {
      const next = decodeURIComponent(current);
      if (next === current) return current;
      current = next;
    } catch {
      return current;
    }
  }
  return current;
}

function stripFileUrl(value: string): string {
  if (!/^file:/i.test(value)) return value;
  let rest = value.replace(/^file:\/\//i, '');
  if (/^localhost\//i.test(rest)) rest = rest.slice('localhost'.length);
  if (rest !== '' && !rest.startsWith('/') && !/^[A-Za-z]:/.test(rest)) {
    rest = `/${rest}`;
  }
  return unwrapPercentEncoding(rest);
}

/**
 * Unwrap encodings to a filesystem path (or the original short name).
 */
export function decodeEncodedProjectPath(raw: string): string {
  const value = unwrapPercentEncoding(raw).trim();
  return stripFileUrl(value).trim();
}

/**
 * Display / aggregate project key: unwrap encodings, then last path segment.
 * Does not spawn git — safe in hot aggregate loops and in the renderer.
 */
export function normalizeProjectName(project: string): string {
  const decoded = decodeEncodedProjectPath(project).replace(/[\\/]+$/, '');
  if (!decoded || decoded === 'unknown') return 'unknown';
  return posixBasename(decoded);
}

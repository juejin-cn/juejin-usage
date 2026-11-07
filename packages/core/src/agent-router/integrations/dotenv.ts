import { RouterError } from '../config.js';

interface Entry { key: string; value: string; start: number; end: number; valueStart: number; valueEnd: number; quote: string }
const invalid = (): never => { throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409); };
/** Parse offsets as well as values so comments, export prefixes and CRLF survive. */
export function dotenvEntries(text: string): Entry[] {
  const entries: Entry[] = []; const keys = new Set<string>(); let at = 0;
  while (at < text.length) {
    const start = at; const eol = text.indexOf('\n', at); const lineEnd = eol < 0 ? text.length : eol + 1;
    if (/^[ \t]*(?:#[^\r\n]*)?[\r\n]*$/.test(text.slice(at, lineEnd))) { at = lineEnd; continue; }
    const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(text.slice(at));
    if (!match || keys.has(match[1])) return invalid();
    const key = match[1]; keys.add(key); const valueStart = at + match[0].length;
    const quote = ['"', "'", '`'].includes(text[valueStart]) ? text[valueStart] : '';
    let valueEnd: number; let value: string; let end: number;
    if (quote) {
      let close = valueStart + 1;
      for (; close < text.length; close++) {
        if (text[close] !== quote) continue;
        let slash = close - 1; while (slash > valueStart && text[slash] === '\\') slash--;
        if ((close - slash - 1) % 2 === 0 || quote === "'") break;
      }
      if (close >= text.length) invalid();
      valueEnd = close + 1; const next = text.indexOf('\n', valueEnd); end = next < 0 ? text.length : next + 1;
      if (!/^[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(text.slice(valueEnd, end))) invalid();
      value = text.slice(valueStart + 1, close);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else {
      end = lineEnd; const raw = text.slice(valueStart, end).split('#')[0].trimEnd(); valueEnd = valueStart + raw.length; value = raw;
    }
    entries.push({ key, value, start, end, valueStart, valueEnd, quote }); at = end;
  }
  return entries;
}
export function dotenvDocument(text: string): Record<string, string> { return Object.fromEntries(dotenvEntries(text).map(e => [e.key, e.value])); }
export function editDotenv(text: string, key: string, desired: { present: boolean; value?: unknown }): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid();
  const entry = dotenvEntries(text).find(e => e.key === key);
  if (!desired.present) return entry ? text.slice(0, entry.start) + text.slice(entry.end) : text;
  if (typeof desired.value !== 'string' || /[\x00\r\n]/.test(desired.value)) return invalid();
  const value = desired.value;
  // Managed values contain no interpolation; refuse values requiring ambiguous escaping.
  if (/["'`\\$]/.test(value)) invalid();
  const encoded = entry?.quote ? entry.quote + value + entry.quote : /^[^\s#]*$/.test(value) ? value : '"' + value + '"';
  if (entry) return text.slice(0, entry.valueStart) + encoded + text.slice(entry.valueEnd);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return text + (text && !text.endsWith('\n') ? nl : '') + key + '=' + encoded + nl;
}

/** Restore the original lexical value, including interpolation and multiline quotes. */
export function restoreDotenv(text: string, baseline: string, key: string, desired: { present: boolean; value?: unknown }): string {
  if (!desired.present) return editDotenv(text, key, desired);
  const original = dotenvEntries(baseline).find(e => e.key === key);
  if (!original || original.value !== desired.value) return invalid();
  const raw = baseline.slice(original.valueStart, original.valueEnd);
  const current = dotenvEntries(text).find(e => e.key === key);
  if (current) return text.slice(0, current.valueStart) + raw + text.slice(current.valueEnd);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return text + (text && !text.endsWith('\n') ? nl : '') + key + '=' + raw + nl;
}
